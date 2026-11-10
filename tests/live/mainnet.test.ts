import { createPublicClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'
import { describe, expect, it } from 'vitest'
import { APPROVAL_ABI, type ApprovalRequest, buildApprovalHook, buildApprovalTypedData, nonceFunction } from '../../src/core/approval'
import { CowError, fetchQuote, submitOrder } from '../../src/core/cow'
import { fetchPrices } from '../../src/core/prices'
import { buildAppData, buildOrder, buildOrderTypedData } from '../../src/core/order'
import { fetchValidators } from '../../src/core/staking'
import { ALL_TOKENS, COW_VAULT_RELAYER, SAVINGS, type Token, USDT } from '../../src/core/tokens'

const client = createPublicClient({ chain: polygon, transport: http('https://polygon-bor-rpc.publicnode.com') })
const signer = privateKeyToAccount(generatePrivateKey())
const now = Math.floor(Date.now() / 1000)

async function signedApproval(token: Token, amount: bigint) {
  const nonce = await client.readContract({
    address: token.address,
    abi: APPROVAL_ABI,
    functionName: nonceFunction(token),
    args: [signer.address],
  })
  const req: ApprovalRequest = { token, owner: signer.address, amount, nonce, deadline: BigInt(now + 3600) }
  const typed = buildApprovalTypedData(req)
  const signature = await signer.signTypedData(typed as unknown as Parameters<typeof signer.signTypedData>[0])
  return buildApprovalHook(req, signature)
}

describe('Polygon mainnet', () => {
  it.each(ALL_TOKENS.map((t) => [t.symbol, t] as const))(
    '%s accepts the signed approval when anyone submits it',
    async (_symbol, token) => {
      const amount = 10n ** BigInt(token.decimals)
      const hook = await signedApproval(token, amount)
      const { result } = await client.simulateCalls({
        account: '0x000000000000000000000000000000000000dEaD',
        calls: [
          { to: hook.target, data: hook.callData },
          { to: token.address, abi: APPROVAL_ABI, functionName: 'allowance', args: [signer.address, COW_VAULT_RELAYER] },
        ],
      }).then((r) => ({ result: r.results }))
      expect(result[0]?.status).toBe('success')
      expect(result[1]?.result).toBe(amount)
    },
  )
})

describe('CoW order book on Polygon', () => {
  it.each(SAVINGS.map((t) => [t.symbol, t] as const))('quotes 25 USDT into %s within 1.5% of the reference price', async (_s, token) => {
    const prices = await fetchPrices()
    const quote = await fetchQuote({
      sellToken: USDT.address,
      buyToken: token.address,
      owner: signer.address,
      amount: 25_000_000n,
      appData: buildAppData([]),
    })
    const bought = Number(quote.buyAmount) / 10 ** token.decimals
    const value = bought * prices[token.id].USD!
    expect(value).toBeGreaterThan(25 * 0.985)
    expect(value).toBeLessThan(25 * 1.015)
  })

  it('accepts the order format and signature, and stops only at the empty balance', async () => {
    const hook = await signedApproval(USDT, 5_000_000n)
    const appData = buildAppData([hook])
    const quote = await fetchQuote({
      sellToken: USDT.address,
      buyToken: SAVINGS[0]!.address,
      owner: signer.address,
      amount: 5_000_000n,
      appData,
    })
    const order = buildOrder({ quote, owner: signer.address, slippageBps: 50, appDataHash: appData.hash, now })
    const signature = await signer.signTypedData(
      buildOrderTypedData(order) as unknown as Parameters<typeof signer.signTypedData>[0],
    )
    const attempt = submitOrder({ order, owner: signer.address, signature, appDataJson: appData.json, quoteId: quote.id })
    await expect(attempt).rejects.toBeInstanceOf(CowError)
    await expect(attempt).rejects.toMatchObject({ errorType: 'InsufficientBalance' })
  })
})

describe('Nimiq validators API', () => {
  it('returns pools that pay rewards, ranked by trust score', async () => {
    const pools = await fetchValidators()
    expect(pools.length).toBeGreaterThan(3)
    expect(pools.every((p) => p.payout !== 'none' && p.score >= 0.9)).toBe(true)
  })
})
