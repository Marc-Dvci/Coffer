import { decodeFunctionData, recoverTypedDataAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { APPROVAL_ABI } from '../../src/core/approval'
import { CowError } from '../../src/core/cow'
import { type MoveRequest, type MoveStep, previewQuote, runMove } from '../../src/core/move'
import { buildOrderTypedData } from '../../src/core/order'
import { COW_VAULT_RELAYER, EURO, GOLD, USDT } from '../../src/core/tokens'
import {
  at,
  type CallLog,
  createMoveDeps,
  orderStatus,
  owner,
  START_SECONDS,
  toTypedInput,
  TX_HASH,
  UID,
  usdtToGoldQuote,
} from './helpers'

const HUNDRED_USDT = 100_000_000n
const MOVE_IN: MoveRequest = { owner, sell: USDT, buy: GOLD, amount: HUNDRED_USDT }
const FILLED = orderStatus('fulfilled')

function named<N extends CallLog['name']>(calls: CallLog[], name: N): Extract<CallLog, { name: N }>[] {
  return calls.filter((c): c is Extract<CallLog, { name: N }> => c.name === name)
}

describe('runMove, the settled path', () => {
  it('reports what the order book executed and the balance read after settlement', async () => {
    const { deps } = createMoveDeps({
      polls: [orderStatus('open'), FILLED],
      balances: { gold: 0n },
      balancesAfterSettlement: { gold: 25_000_000_000_000_000n },
    })
    expect(await runMove(deps, MOVE_IN)).toEqual({
      outcome: 'settled',
      uid: UID,
      txHash: TX_HASH,
      sold: 100_000_000n,
      received: 25_000_000_000_000_000n,
      fee: 300_000n,
      balanceBefore: 0n,
      balanceAfter: 25_000_000_000_000_000n,
    })
  })

  it('asks for two signatures in order: the approval, then the order', async () => {
    const { deps, calls } = createMoveDeps({ polls: [FILLED] })
    await runMove(deps, MOVE_IN)
    expect(named(calls, 'sign').map((c) => c.primaryType)).toEqual(['Permit', 'Order'])
  })

  it('signs an approval for exactly the amount moved, to the CoW vault relayer', async () => {
    const { deps, calls } = createMoveDeps({ polls: [FILLED], nonce: 7n })
    await runMove(deps, MOVE_IN)
    expect(at(named(calls, 'sign'), 0).data.message).toMatchObject({
      owner,
      spender: COW_VAULT_RELAYER,
      value: '100000000',
      nonce: '7',
      deadline: String(START_SECONDS + 3600),
    })
  })

  it('carries the signed approval inside the order as a pre-settlement call on the token', async () => {
    const { deps, calls } = createMoveDeps({ polls: [FILLED] })
    await runMove(deps, MOVE_IN)
    const doc = JSON.parse(at(named(calls, 'submit'), 0).appDataJson) as {
      metadata: { hooks: { pre: { target: string; callData: `0x${string}` }[] } }
    }
    const hook = at(doc.metadata.hooks.pre, 0)
    expect(hook.target).toBe(USDT.address)
    const call = decodeFunctionData({ abi: APPROVAL_ABI, data: hook.callData })
    expect(call.functionName).toBe('permit')
    expect(call.args?.slice(0, 3)).toEqual([owner, COW_VAULT_RELAYER, HUNDRED_USDT])
  })

  it('quotes with the same order document it later submits', async () => {
    const { deps, calls } = createMoveDeps({ polls: [FILLED] })
    await runMove(deps, MOVE_IN)
    const quoted = at(named(calls, 'quote'), 0)
    const submitted = at(named(calls, 'submit'), 0)
    expect(submitted.appDataJson).toBe(quoted.appData.json)
    expect(submitted.order.appData).toBe(quoted.appData.hash)
    expect(submitted.quoteId).toBe(42)
  })

  it('submits an order signed by the owner, who is its only receiver', async () => {
    const { deps, calls } = createMoveDeps({ polls: [FILLED] })
    await runMove(deps, MOVE_IN)
    const { order, signature } = at(named(calls, 'submit'), 0)
    const signer = await recoverTypedDataAddress({ ...toTypedInput(buildOrderTypedData(order)), signature })
    expect(signer).toBe(owner)
    expect(order.receiver).toBe(owner)
    expect(order.sellAmount).toBe(HUNDRED_USDT)
  })

  it('skips the approval signature when the allowance already covers the amount', async () => {
    const { deps, calls } = createMoveDeps({ polls: [FILLED], allowance: HUNDRED_USDT })
    await runMove(deps, MOVE_IN)
    expect(named(calls, 'sign').map((c) => c.primaryType)).toEqual(['Order'])
    expect(at(named(calls, 'submit'), 0).appDataJson).not.toContain('hooks')
  })

  it('asks for the approval again when the allowance is one unit short', async () => {
    const { deps, calls } = createMoveDeps({ polls: [FILLED], allowance: HUNDRED_USDT - 1n })
    await runMove(deps, MOVE_IN)
    expect(named(calls, 'sign')).toHaveLength(2)
  })

  it('signs a meta-transaction when gold is brought back to USDT', async () => {
    const amount = 10n ** 17n
    const { deps, calls } = createMoveDeps({
      polls: [FILLED],
      quote: { sellToken: GOLD.address, buyToken: USDT.address, sellAmount: amount, buyAmount: 400_000_000n, feeAmount: 0n, id: 1 },
    })
    const result = await runMove(deps, { owner, sell: GOLD, buy: USDT, amount })
    expect(result.outcome).toBe('settled')
    expect(at(named(calls, 'sign'), 0).primaryType).toBe('MetaTransaction')
  })

  it('reports each step in order as the move advances', async () => {
    const { deps } = createMoveDeps({ polls: [orderStatus('open'), FILLED] })
    const steps: MoveStep['step'][] = []
    await runMove(deps, MOVE_IN, (s) => steps.push(s.step))
    expect(steps).toEqual(['approval-signature', 'quote', 'order-signature', 'placed', 'settling', 'settling'])
  })

  it('polls every four seconds until the order is filled', async () => {
    const { deps, calls } = createMoveDeps({ polls: [orderStatus('open'), orderStatus('open'), FILLED] })
    await runMove(deps, MOVE_IN)
    expect(named(calls, 'wait').map((c) => c.ms)).toEqual([4000, 4000])
  })

  it('keeps polling through an order-book error', async () => {
    const { deps } = createMoveDeps({ polls: [new CowError('Http503', 'busy'), FILLED] })
    expect((await runMove(deps, MOVE_IN)).outcome).toBe('settled')
  })

  it('settles with no transaction hash when the trades lookup fails', async () => {
    const { deps } = createMoveDeps({ polls: [FILLED], tradeHashes: new CowError('Http500', 'down') })
    expect(await runMove(deps, MOVE_IN)).toMatchObject({ outcome: 'settled', txHash: null })
  })
})

describe('runMove, moves that stop before anything is placed', () => {
  it('refuses an amount above the balance before any signature', async () => {
    const { deps, calls } = createMoveDeps({ balances: { usdt: HUNDRED_USDT - 1n } })
    expect(await runMove(deps, MOVE_IN)).toEqual({ outcome: 'refused', refusal: { code: 'exceeds-balance' } })
    expect(calls).toEqual([])
  })

  it('reports a declined approval signature and places nothing', async () => {
    const { deps, calls } = createMoveDeps({
      signer: () => Promise.reject(Object.assign(new Error('User rejected'), { code: 4001 })),
    })
    expect(await runMove(deps, MOVE_IN)).toEqual({ outcome: 'declined', at: 'approval-signature' })
    expect(named(calls, 'submit')).toEqual([])
  })

  it('reports a declined order signature and places nothing', async () => {
    let asked = 0
    const base = createMoveDeps()
    const { deps, calls } = createMoveDeps({
      signer: (data) => {
        asked += 1
        return asked === 1 ? base.deps.signTypedData(owner, data) : Promise.reject(new Error('Request cancelled by user'))
      },
    })
    expect(await runMove(deps, MOVE_IN)).toEqual({ outcome: 'declined', at: 'order-signature' })
    expect(named(calls, 'submit')).toEqual([])
  })

  it.each(['approval', 'order'] as const)('passes on a wallet failure at the %s signature that is not a refusal', async (stage) => {
    const { deps } = createMoveDeps({
      allowance: stage === 'order' ? HUNDRED_USDT : 0n,
      signer: () => Promise.reject(new Error('Wallet is locked')),
    })
    await expect(runMove(deps, MOVE_IN)).rejects.toThrow('Wallet is locked')
  })

  it('refuses a quote that breaks a limit, before the order signature', async () => {
    const { deps, calls } = createMoveDeps({
      quote: usdtToGoldQuote(HUNDRED_USDT, { buyAmount: 24_000_000_000_000_000n }),
    })
    expect(await runMove(deps, MOVE_IN)).toEqual({
      outcome: 'refused',
      refusal: { code: 'price-off-reference', deviationBps: 400 },
    })
    expect(named(calls, 'sign').map((c) => c.primaryType)).toEqual(['Permit'])
  })

  it('refuses a move when the reference price is missing', async () => {
    const { deps } = createMoveDeps({ prices: { gold: undefined } })
    expect(await runMove(deps, MOVE_IN)).toEqual({ outcome: 'refused', refusal: { code: 'no-reference-price' } })
  })

  it('reports the order book reason when the quote is rejected', async () => {
    const { deps } = createMoveDeps({ quote: new CowError('NoLiquidity', 'No route was found for this pair') })
    expect(await runMove(deps, MOVE_IN)).toEqual({ outcome: 'rejected', reason: 'No route was found for this pair' })
  })

  it('reports the order book reason when the order is rejected', async () => {
    const { deps } = createMoveDeps({ submitResult: new CowError('InsufficientBalance', 'The balance is too low') })
    expect(await runMove(deps, MOVE_IN)).toEqual({ outcome: 'rejected', reason: 'The balance is too low' })
  })

  it.each(['quote', 'submitResult'] as const)('passes on a network failure from the %s call', async (key) => {
    const { deps } = createMoveDeps({ [key]: new TypeError('Failed to fetch') })
    await expect(runMove(deps, MOVE_IN)).rejects.toThrow('Failed to fetch')
  })

  it('passes on a failure of the order status call that the book did not send', async () => {
    const { deps } = createMoveDeps({ polls: [new TypeError('Failed to fetch')] })
    await expect(runMove(deps, MOVE_IN)).rejects.toThrow('Failed to fetch')
  })
})

describe('runMove, orders that are not filled', () => {
  it.each(['expired', 'cancelled'] as const)('reports an order the book marks %s as expired', async (state) => {
    const { deps } = createMoveDeps({ polls: [orderStatus('open'), orderStatus(state)] })
    expect(await runMove(deps, MOVE_IN)).toEqual({ outcome: 'expired', uid: UID })
  })

  it('stops polling one minute after the order lifetime and reports it expired', async () => {
    const { deps, clock } = createMoveDeps({ polls: [orderStatus('open')] })
    expect(await runMove(deps, MOVE_IN)).toEqual({ outcome: 'expired', uid: UID })
    expect(clock.now).toBeGreaterThan(START_SECONDS + 20 * 60 + 60)
    expect(clock.now).toBeLessThanOrEqual(START_SECONDS + 20 * 60 + 60 + 4)
  })
})

describe('previewQuote', () => {
  it('quotes with an order document that carries no approval', async () => {
    const { deps, calls } = createMoveDeps()
    const quote = await previewQuote(deps, { owner, sell: USDT, buy: EURO, amount: 5_000_000n })
    expect(quote.sellAmount).toBe(5_000_000n)
    const asked = at(named(calls, 'quote'), 0)
    expect(asked).toMatchObject({ sellToken: USDT.address, buyToken: EURO.address, amount: 5_000_000n })
    expect(asked.appData.json).toBe('{"appCode":"Coffer","metadata":{},"version":"1.3.0"}')
    expect(named(calls, 'sign')).toEqual([])
  })
})
