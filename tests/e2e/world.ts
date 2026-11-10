import type { Page, Route } from '@playwright/test'
import {
  type Address,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  toBytes,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { APPROVAL_ABI } from '../../src/core/approval'
import { buildOrderTypedData, type Order } from '../../src/core/order'
import { ALL_TOKENS, COW_VAULT_RELAYER } from '../../src/core/tokens'

/** A well-known test key. It signs for real, so every signature the app asks for is checked. */
export const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
export const account = privateKeyToAccount(TEST_KEY)
export const NIM_WALLET = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0001'
export const NIM_HTLC = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0002'

const MULTICALL = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])

const PRICES = {
  'pax-gold': { usd: 4000, eur: 3600, crc: 1800000 },
  'monerium-eur-money': { usd: 1.11, eur: 1, crc: 500 },
  'wrapped-bitcoin': { usd: 74000, eur: 66600, crc: 33300000 },
  'nimiq-2': { usd: 0.00025, eur: 0.000225, crc: 0.1125 },
  tether: { usd: 1, eur: 0.9, crc: 450 },
}

const VALIDATORS = [
  { address: 'NQ11 AAAA AAAA AAAA AAAA AAAA AAAA AAAA AAAA', name: 'Harbour Pool', fee: 0.02, payoutType: 'restake', score: { total: 0.999 } },
  { address: 'NQ22 BBBB BBBB BBBB BBBB BBBB BBBB BBBB BBBB', name: 'Low Trust Pool', fee: 0, payoutType: 'restake', score: { total: 0.5 } },
  { address: 'NQ33 CCCC CCCC CCCC CCCC CCCC CCCC CCCC CCCC', name: 'Quay Pool', fee: 0.05, payoutType: 'direct', score: { total: 0.999 } },
]

export interface World {
  balances: Record<string, bigint>
  allowances: Record<string, bigint>
  nimLuna: number[]
  /** Typed-data requests the wallet signed, by primary type. */
  signed: string[]
  /** When set, the wallet rejects the next signature request. */
  rejectNext: boolean
  submitted: { body: Record<string, unknown>; signer: Address }[]
  staked: { method: string; args: Record<string, unknown> }[]
  /** Polls answered "open" before the order is reported filled. */
  pollsBeforeFill: number
  expire: boolean
  userFiat: string
}

const UID = `0x${'ab'.repeat(56)}`
const TX_HASH = `0x${'cd'.repeat(32)}`

function tokenOf(address: string) {
  return ALL_TOKENS.find((t) => t.address.toLowerCase() === address.toLowerCase())
}

function answerCall(world: World, to: string, data: Hex): Hex {
  const token = tokenOf(to)
  if (!token) return '0x'
  const call = decodeFunctionData({ abi: APPROVAL_ABI, data })
  const key = token.id
  switch (call.functionName) {
    case 'balanceOf':
      return encodeFunctionResult({ abi: APPROVAL_ABI, functionName: 'balanceOf', result: world.balances[key] ?? 0n })
    case 'allowance':
      return encodeFunctionResult({ abi: APPROVAL_ABI, functionName: 'allowance', result: world.allowances[key] ?? 0n })
    case 'nonces':
      return encodeFunctionResult({ abi: APPROVAL_ABI, functionName: 'nonces', result: 3n })
    case 'getNonce':
      return encodeFunctionResult({ abi: APPROVAL_ABI, functionName: 'getNonce', result: 5n })
    default:
      return '0x'
  }
}

function answerRpc(world: World, req: { method: string; params?: unknown[]; id: number }): unknown {
  if (req.method === 'eth_chainId') return '0x89'
  if (req.method === 'eth_call') {
    const { to, data } = (req.params as [{ to: string; data: Hex }])[0]
    if (to.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') {
      const { args } = decodeFunctionData({ abi: MULTICALL, data })
      const results = (args[0] as readonly { target: string; callData: Hex }[]).map((c) => ({
        success: true,
        returnData: answerCall(world, c.target, c.callData),
      }))
      return encodeFunctionResult({ abi: MULTICALL, functionName: 'aggregate3', result: results })
    }
    return answerCall(world, to, data)
  }
  return null
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  })
}

/** Installs the wallet and the network the app talks to. Returns the state the test can read and change. */
export async function installWorld(page: Page, opts: { insidePay: boolean; userFiat?: string }): Promise<World> {
  const world: World = {
    balances: { usdt: 120_000_000n, gold: 0n, euro: 0n, bitcoin: 0n },
    allowances: {},
    nimLuna: [0, 250_000_000],
    signed: [],
    rejectNext: false,
    submitted: [],
    staked: [],
    pollsBeforeFill: 1,
    expire: false,
    userFiat: opts.userFiat ?? 'EUR',
  }
  let lastOrder: Record<string, unknown> | null = null
  let polls = 0

  await page.route(/publicnode\.com|drpc\.org|1rpc\.io/, async (route) => {
    const req = route.request().postDataJSON() as { method: string; params?: unknown[]; id: number }
    await json(route, { jsonrpc: '2.0', id: req.id, result: answerRpc(world, req) })
  })
  await page.route(/api\.coingecko\.com/, (route) => json(route, PRICES))
  await page.route(/validators/, (route) => json(route, VALIDATORS))
  await page.route(/rpc\.nimiqwatch\.com/, (route) =>
    json(route, { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error', data: 'No staker' } }),
  )
  await page.route(/api\.cow\.fi/, async (route) => {
    const url = route.request().url()
    const method = route.request().method()
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
      return
    }
    if (url.endsWith('/quote')) {
      const body = route.request().postDataJSON() as { sellToken: string; buyToken: string; sellAmountBeforeFee: string }
      const sell = tokenOf(body.sellToken)!
      const buy = tokenOf(body.buyToken)!
      const usd = (id: string) => ({ usdt: 1, gold: 4000, euro: 1.11, bitcoin: 74000 })[id]!
      const amount = BigInt(body.sellAmountBeforeFee)
      const fee = amount / 2000n
      const sold = amount - fee
      const bought =
        (sold * BigInt(Math.round(usd(sell.id) * 1e6)) * 10n ** BigInt(buy.decimals)) /
        (BigInt(Math.round(usd(buy.id) * 1e6)) * 10n ** BigInt(sell.decimals))
      await json(route, { quote: { sellAmount: sold, buyAmount: (bought * 999n) / 1000n, feeAmount: fee }, id: 77 })
      return
    }
    if (url.endsWith('/orders') && method === 'POST') {
      const body = route.request().postDataJSON() as Record<string, string | number | boolean>
      const appJson = body.appData as string
      if (keccak256(toBytes(appJson)) !== body.appDataHash) {
        await json(route, { errorType: 'InvalidAppData', description: 'appData hash mismatch' }, 400)
        return
      }
      const order: Order = {
        sellToken: body.sellToken as Address,
        buyToken: body.buyToken as Address,
        receiver: body.receiver as Address,
        sellAmount: BigInt(body.sellAmount as string),
        buyAmount: BigInt(body.buyAmount as string),
        validTo: body.validTo as number,
        appData: body.appDataHash as Hex,
        feeAmount: 0n,
        kind: 'sell',
        partiallyFillable: false,
        sellTokenBalance: 'erc20',
        buyTokenBalance: 'erc20',
      }
      const signer = await recoverTypedDataAddress({
        ...(buildOrderTypedData(order) as unknown as Parameters<typeof recoverTypedDataAddress>[0]),
        signature: body.signature as Hex,
      })
      world.submitted.push({ body, signer })
      lastOrder = body
      polls = 0
      await json(route, UID, 201)
      return
    }
    if (url.includes('/trades')) {
      await json(route, [{ txHash: TX_HASH }])
      return
    }
    if (url.includes('/account/')) {
      await json(route, lastOrder ? [orderJson(lastOrder, 'fulfilled')] : [])
      return
    }
    if (url.includes('/orders/') && lastOrder) {
      polls += 1
      if (world.expire) {
        await json(route, orderJson(lastOrder, 'expired'))
        return
      }
      const filled = polls > world.pollsBeforeFill
      if (filled) {
        const sell = tokenOf(lastOrder.sellToken as string)!
        const buy = tokenOf(lastOrder.buyToken as string)!
        world.balances[sell.id] = (world.balances[sell.id] ?? 0n) - BigInt(lastOrder.sellAmount as string)
        world.balances[buy.id] = (world.balances[buy.id] ?? 0n) + BigInt(lastOrder.buyAmount as string)
      }
      await json(route, orderJson(lastOrder, filled ? 'fulfilled' : 'open'))
      return
    }
    await json(route, { errorType: 'NotFound', description: 'not found' }, 404)
  })

  await page.exposeFunction('__coffer_sign', async (typedJson: string): Promise<Hex | null> => {
    const data = JSON.parse(typedJson) as { primaryType: string }
    if (world.rejectNext) {
      world.rejectNext = false
      return null
    }
    world.signed.push(data.primaryType)
    return account.signTypedData(data as unknown as Parameters<typeof account.signTypedData>[0])
  })
  await page.exposeFunction('__coffer_stake', (method: string, args: Record<string, unknown>) => {
    world.staked.push({ method, args })
    return 'f'.repeat(64)
  })
  await page.exposeFunction('__coffer_nim', () => world.nimLuna)

  if (opts.insidePay) {
    await page.addInitScript(
      ({ owner, wallet, htlc, fiat }) => {
        const w = window as unknown as Record<string, unknown>
        const call = (name: string, ...args: unknown[]) => (w[name] as (...a: unknown[]) => Promise<unknown>)(...args)
        w.ethereum = {
          request: async ({ method, params }: { method: string; params?: unknown[] }) => {
            if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [owner]
            if (method === 'eth_chainId') return '0x89'
            if (method === 'wallet_switchEthereumChain') return null
            if (method === 'eth_signTypedData_v4') {
              const sig = await call('__coffer_sign', (params as string[])[1])
              if (sig === null) throw Object.assign(new Error('User rejected the request'), { code: 4001 })
              return sig
            }
            throw new Error(`Unsupported method ${method}`)
          },
        }
        w.nimiqPay = { userFiat: fiat, language: 'en', network: 'mainnet' }
        const stakeCall = (method: string) => (args: Record<string, unknown>) => call('__coffer_stake', method, args)
        w.nimiq = {
          listAccounts: async () => [wallet, htlc],
          getBalance: async (address: string) => {
            const [a, b] = (await call('__coffer_nim')) as number[]
            return address === wallet ? a : b
          },
          sendNewStakerTransaction: stakeCall('sendNewStakerTransaction'),
          sendStakeTransaction: stakeCall('sendStakeTransaction'),
          on: () => {},
          once: () => {},
          request: async () => null,
        }
      },
      { owner: account.address, wallet: NIM_WALLET, htlc: NIM_HTLC, fiat: world.userFiat },
    )
  }
  return world
}

function orderJson(body: Record<string, unknown>, status: string): Record<string, unknown> {
  const filled = status === 'fulfilled'
  return {
    uid: UID,
    status,
    sellToken: body.sellToken,
    buyToken: body.buyToken,
    executedSellAmount: filled ? body.sellAmount : '0',
    executedBuyAmount: filled ? body.buyAmount : '0',
    executedFee: filled ? '12500' : '0',
    creationDate: '2026-11-10T18:00:00.000Z',
    fullAppData: body.appData,
  }
}

export { COW_VAULT_RELAYER, TX_HASH, UID }
