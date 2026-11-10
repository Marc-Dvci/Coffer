import type { Address, Hex, hashTypedData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { TypedData } from '../../src/core/approval'
import type { Fetch, OrderState, OrderStatus } from '../../src/core/cow'
import type { MoveDeps } from '../../src/core/move'
import type { Order, Quote } from '../../src/core/order'
import { GOLD, type HoldingId, USDT } from '../../src/core/tokens'

export const TEST_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
export const account = privateKeyToAccount(TEST_KEY)
export const owner: Address = account.address

/** Unix seconds of the fake clock at the start of every test. */
export const START_SECONDS = 1_800_000_000

export const UID: Hex = `0x${'ab'.repeat(56)}`
export const TX_HASH: Hex = `0x${'cd'.repeat(32)}`

export function at<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`no item at index ${index}`)
  return item
}

/** The builders produce the eth_signTypedData JSON shape; viem's generic signatures are narrower. */
export function toTypedInput(data: TypedData): Parameters<typeof hashTypedData>[0] {
  return data as unknown as Parameters<typeof hashTypedData>[0]
}

export function signForTest(data: TypedData): Promise<Hex> {
  return account.signTypedData(toTypedInput(data))
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export interface Recorded {
  url: string
  init?: RequestInit
}

export function fakeFetch(respond: (url: string, init?: RequestInit) => Response): {
  fetchFn: Fetch
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const fetchFn: Fetch = async (url, init) => {
    calls.push({ url, init })
    return respond(url, init)
  }
  return { fetchFn, calls }
}

export function orderStatus(state: OrderState, overrides: Partial<OrderStatus> = {}): OrderStatus {
  return {
    uid: UID,
    state,
    sellToken: USDT.address,
    buyToken: GOLD.address,
    executedSellAmount: 100_000_000n,
    executedBuyAmount: 25_000_000_000_000_000n,
    executedFee: 300_000n,
    createdAt: '2026-11-10T10:00:00Z',
    appCode: 'Coffer',
    ...overrides,
  }
}

/** A 100 USDT to PAXG quote at $1 and $4000 per token, with no fee and no slippage in the book. */
export function usdtToGoldQuote(amount: bigint, overrides: Partial<Quote> = {}): Quote {
  return {
    sellToken: USDT.address,
    buyToken: GOLD.address,
    sellAmount: amount,
    buyAmount: amount * 250_000_000n,
    feeAmount: 0n,
    id: 42,
    ...overrides,
  }
}

export type CallLog =
  | { name: 'sign'; owner: Address; primaryType: string; data: TypedData }
  | {
      name: 'quote'
      sellToken: Address
      buyToken: Address
      amount: bigint
      appData: { json: string; hash: Hex }
    }
  | { name: 'submit'; order: Order; signature: Hex; appDataJson: string; quoteId: number | null }
  | { name: 'order'; uid: string }
  | { name: 'tradeHashes'; uid: string }
  | { name: 'wait'; ms: number }

export interface MoveFixture {
  /** Balances before settlement; missing holdings read as zero unless they have a default. */
  balances?: Partial<Record<HoldingId, bigint>>
  /** Balances once the order has been fulfilled. */
  balancesAfterSettlement?: Partial<Record<HoldingId, bigint>>
  allowance?: bigint
  nonce?: bigint
  /** Reference prices in US dollars per whole token; set a key to undefined to remove it. */
  prices?: Partial<Record<HoldingId, number | undefined>>
  quote?: Quote | Error
  submitResult?: string | Error
  /** Answers to successive order polls. The last answer repeats once the script runs out. */
  polls?: (OrderStatus | Error)[]
  tradeHashes?: Hex[] | Error
  signer?: (data: TypedData) => Promise<Hex>
}

const DEFAULT_BALANCES: Partial<Record<HoldingId, bigint>> = {
  usdt: 1_000_000_000n,
  gold: 10n * 10n ** 18n,
  euro: 0n,
  bitcoin: 0n,
}

const DEFAULT_PRICES: Partial<Record<HoldingId, number>> = {
  usdt: 1,
  gold: 4000,
  euro: 1.1,
  bitcoin: 74000,
}

/**
 * In-memory MoveDeps. Signing is real, with the test key. The clock moves only
 * through `wait`, so polling and expiry are deterministic.
 */
export function createMoveDeps(fixture: MoveFixture = {}): {
  deps: MoveDeps
  calls: CallLog[]
  clock: { now: number }
} {
  const clock = { now: START_SECONDS }
  const calls: CallLog[] = []
  const before = { ...DEFAULT_BALANCES, ...fixture.balances }
  const after = fixture.balancesAfterSettlement ?? {}
  const prices = { ...DEFAULT_PRICES, ...fixture.prices }
  let settled = false
  let pollCount = 0

  const deps: MoveDeps = {
    now: () => clock.now,
    balanceOf: async (token) => {
      const holdings = settled ? { ...before, ...after } : before
      return holdings[token.id] ?? 0n
    },
    allowance: async () => fixture.allowance ?? 0n,
    nonce: async () => fixture.nonce ?? 7n,
    signTypedData: async (signer, data) => {
      calls.push({ name: 'sign', owner: signer, primaryType: data.primaryType, data })
      return (fixture.signer ?? signForTest)(data)
    },
    quote: async (req) => {
      calls.push({
        name: 'quote',
        sellToken: req.sellToken,
        buyToken: req.buyToken,
        amount: req.amount,
        appData: req.appData,
      })
      const result = fixture.quote ?? usdtToGoldQuote(req.amount)
      if (result instanceof Error) throw result
      return result
    },
    submit: async (sub) => {
      calls.push({
        name: 'submit',
        order: sub.order,
        signature: sub.signature,
        appDataJson: sub.appDataJson,
        quoteId: sub.quoteId,
      })
      const result = fixture.submitResult ?? UID
      if (result instanceof Error) throw result
      return result
    },
    order: async (uid) => {
      calls.push({ name: 'order', uid })
      const script = fixture.polls ?? [orderStatus('open')]
      const entry = script[Math.min(pollCount, script.length - 1)]
      pollCount += 1
      if (entry === undefined) throw new Error('empty poll script')
      if (entry instanceof Error) throw entry
      if (entry.state === 'fulfilled') settled = true
      return entry
    },
    tradeHashes: async (uid) => {
      calls.push({ name: 'tradeHashes', uid })
      const result = fixture.tradeHashes ?? [TX_HASH]
      if (result instanceof Error) throw result
      return result
    },
    priceUsd: (token) => prices[token.id],
    wait: async (ms) => {
      calls.push({ name: 'wait', ms })
      clock.now += ms / 1000
    },
  }
  return { deps, calls, clock }
}
