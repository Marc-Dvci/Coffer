import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import {
  COW_API,
  CowError,
  type Fetch,
  fetchOrder,
  fetchOrders,
  fetchQuote,
  fetchTradeHashes,
  type OrderState,
  type OrderSubmission,
  type QuoteRequest,
  submitOrder,
} from '../../src/core/cow'
import { buildAppData, buildOrder, type Quote } from '../../src/core/order'
import { GOLD, USDT } from '../../src/core/tokens'
import { at, fakeFetch, json, owner, type Recorded, UID } from './helpers'

const NOW = 1_800_000_000
const APP_DATA = buildAppData([])
const SIGNATURE: Hex = `0x${'11'.repeat(65)}`

const QUOTE_REQUEST: QuoteRequest = {
  sellToken: USDT.address,
  buyToken: GOLD.address,
  owner,
  amount: 1_000_000n,
  appData: APP_DATA,
}

const QUOTE: Quote = {
  sellToken: USDT.address,
  buyToken: GOLD.address,
  sellAmount: 990_000n,
  buyAmount: 2_475_000_000_000_000_000n,
  feeAmount: 10_000n,
  id: 42,
}

function submission(): OrderSubmission {
  const order = buildOrder({
    quote: QUOTE,
    owner,
    slippageBps: 50,
    appDataHash: APP_DATA.hash,
    now: NOW,
  })
  return { order, owner, signature: SIGNATURE, appDataJson: APP_DATA.json, quoteId: 42 }
}

function rawOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: UID,
    status: 'open',
    sellToken: USDT.address,
    buyToken: GOLD.address,
    executedSellAmount: '0',
    executedBuyAmount: '0',
    executedFee: '0',
    creationDate: '2026-11-10T10:00:00Z',
    fullAppData: APP_DATA.json,
    ...overrides,
  }
}

function bodyOf(call: Recorded): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>
}

async function errorOf(run: () => Promise<unknown>): Promise<CowError> {
  try {
    await run()
  } catch (err) {
    if (err instanceof CowError) return err
    throw err
  }
  throw new Error('expected the call to fail')
}

describe('fetchQuote', () => {
  it('posts the amount before fee, the owner and the app data to the quote endpoint', async () => {
    const { fetchFn, calls } = fakeFetch(() =>
      json({ quote: { sellAmount: '990000', buyAmount: '1', feeAmount: '10000' }, id: 42 }),
    )
    await fetchQuote(QUOTE_REQUEST, fetchFn)
    const call = at(calls, 0)
    expect(call.url).toBe(`${COW_API}/quote`)
    expect(call.init?.method).toBe('POST')
    expect(bodyOf(call)).toEqual({
      sellToken: USDT.address,
      buyToken: GOLD.address,
      from: owner,
      receiver: owner,
      sellAmountBeforeFee: '1000000',
      kind: 'sell',
      signingScheme: 'eip712',
      onchainOrder: false,
      appData: APP_DATA.json,
      appDataHash: APP_DATA.hash,
    })
  })

  it('reads the quoted amounts as bigints and keeps the quote id', async () => {
    const { fetchFn } = fakeFetch(() =>
      json({ quote: { sellAmount: '990000', buyAmount: '2475000000000000000', feeAmount: '10000' }, id: 42 }),
    )
    expect(await fetchQuote(QUOTE_REQUEST, fetchFn)).toEqual({
      sellToken: USDT.address,
      buyToken: GOLD.address,
      sellAmount: 990_000n,
      buyAmount: 2_475_000_000_000_000_000n,
      feeAmount: 10_000n,
      id: 42,
    })
  })

  it('keeps no quote id when the book gives none', async () => {
    const { fetchFn } = fakeFetch(() =>
      json({ quote: { sellAmount: '990000', buyAmount: '1', feeAmount: '10000' } }),
    )
    expect((await fetchQuote(QUOTE_REQUEST, fetchFn)).id).toBeNull()
  })

  it('turns a JSON error answer into a CowError with the book error type and description', async () => {
    const { fetchFn } = fakeFetch(() =>
      json({ errorType: 'NoLiquidity', description: 'no route for this pair' }, 400),
    )
    const error = await errorOf(() => fetchQuote(QUOTE_REQUEST, fetchFn))
    expect(error.errorType).toBe('NoLiquidity')
    expect(error.message).toBe('no route for this pair')
  })
})

describe('submitOrder', () => {
  it('posts the signed order with a zero fee, the full app data and its hash, and the quote id', async () => {
    const { fetchFn, calls } = fakeFetch(() => json(UID))
    await submitOrder(submission(), fetchFn)
    const call = at(calls, 0)
    expect(call.url).toBe(`${COW_API}/orders`)
    expect(call.init?.method).toBe('POST')
    expect(bodyOf(call)).toEqual({
      sellToken: USDT.address,
      buyToken: GOLD.address,
      receiver: owner,
      sellAmount: '1000000',
      buyAmount: '2462625000000000000',
      validTo: NOW + 20 * 60,
      appData: APP_DATA.json,
      appDataHash: APP_DATA.hash,
      feeAmount: '0',
      kind: 'sell',
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
      signingScheme: 'eip712',
      signature: SIGNATURE,
      from: owner,
      quoteId: 42,
    })
  })

  it('returns the unique id the book assigns to the order', async () => {
    const { fetchFn } = fakeFetch(() => json(UID))
    expect(await submitOrder(submission(), fetchFn)).toBe(UID)
  })
})

describe('fetchOrder', () => {
  it('reads the order by its uid', async () => {
    const { fetchFn, calls } = fakeFetch(() => json(rawOrder()))
    await fetchOrder(UID, fetchFn)
    expect(at(calls, 0).url).toBe(`${COW_API}/orders/${UID}`)
  })

  it.each([
    { status: 'presignaturePending', state: 'open' },
    { status: 'open', state: 'open' },
    { status: 'fulfilled', state: 'fulfilled' },
    { status: 'expired', state: 'expired' },
    { status: 'cancelled', state: 'cancelled' },
  ] as { status: string; state: OrderState }[])('maps the book status $status to $state', async ({ status, state }) => {
    const { fetchFn } = fakeFetch(() => json(rawOrder({ status })))
    expect((await fetchOrder(UID, fetchFn)).state).toBe(state)
  })

  it.each([{ field: 'executedFee' }, { field: 'executedFeeAmount' }])(
    'reads the solver fee from $field',
    async ({ field }) => {
      const { fetchFn } = fakeFetch(() => json(rawOrder({ executedFee: undefined, [field]: '1234' })))
      expect((await fetchOrder(UID, fetchFn)).executedFee).toBe(1234n)
    },
  )

  it('reads an order with no executed amounts as zero', async () => {
    const bare = { uid: UID, status: 'open', sellToken: USDT.address, buyToken: GOLD.address, creationDate: 'now' }
    const { fetchFn } = fakeFetch(() => json(bare))
    expect(await fetchOrder(UID, fetchFn)).toMatchObject({
      executedSellAmount: 0n,
      executedBuyAmount: 0n,
      executedFee: 0n,
      appCode: null,
    })
  })

  it.each([
    {
      label: 'an app data document naming Coffer',
      fullAppData: '{"appCode":"Coffer","version":"1.3.0"}',
      appCode: 'Coffer',
    },
    { label: 'no app data', fullAppData: undefined, appCode: null },
    { label: 'null app data', fullAppData: null, appCode: null },
    { label: 'malformed app data', fullAppData: '{"appCode":', appCode: null },
    { label: 'a non-text app code', fullAppData: '{"appCode":42}', appCode: null },
  ] as { label: string; fullAppData: string | null | undefined; appCode: string | null }[])(
    'reads the app code from $label',
    async ({ fullAppData, appCode }) => {
      const { fetchFn } = fakeFetch(() => json(rawOrder({ fullAppData })))
      expect((await fetchOrder(UID, fetchFn)).appCode).toBe(appCode)
    },
  )

  it('turns a JSON error answer into a CowError', async () => {
    const { fetchFn } = fakeFetch(() => json({ errorType: 'OrderNotFound', description: 'unknown uid' }, 404))
    const error = await errorOf(() => fetchOrder(UID, fetchFn))
    expect(error.errorType).toBe('OrderNotFound')
  })
})

describe('fetchOrders', () => {
  it('lists the account orders at the default limit of 50', async () => {
    const { fetchFn, calls } = fakeFetch(() => json([rawOrder(), rawOrder({ status: 'fulfilled' })]))
    const orders = await fetchOrders(owner, undefined, fetchFn)
    expect(at(calls, 0).url).toBe(`${COW_API}/account/${owner}/orders?limit=50`)
    expect(orders.map((o) => o.state)).toEqual(['open', 'fulfilled'])
  })

  it('passes an explicit limit to the account listing', async () => {
    const { fetchFn, calls } = fakeFetch(() => json([]))
    await fetchOrders(owner, 10, fetchFn)
    expect(at(calls, 0).url).toBe(`${COW_API}/account/${owner}/orders?limit=10`)
  })

  it('throws CowError when the account listing fails', async () => {
    const { fetchFn } = fakeFetch(() => json({ errorType: 'Unavailable', description: 'maintenance' }, 503))
    const error = await errorOf(() => fetchOrders(owner, 50, fetchFn))
    expect(error.errorType).toBe('Unavailable')
  })
})

describe('fetchTradeHashes', () => {
  const TX_A: Hex = `0x${'aa'.repeat(32)}`
  const TX_B: Hex = `0x${'bb'.repeat(32)}`

  it('asks for the trades of the order by its uid', async () => {
    const { fetchFn, calls } = fakeFetch(() => json([]))
    await fetchTradeHashes(UID, fetchFn)
    expect(at(calls, 0).url).toBe(`${COW_API}/trades?orderUid=${UID}`)
  })

  it('returns the settlement hashes and drops trades that have none yet', async () => {
    const { fetchFn } = fakeFetch(() =>
      json([{ txHash: TX_A }, { txHash: null }, {}, { txHash: TX_B }]),
    )
    expect(await fetchTradeHashes(UID, fetchFn)).toEqual([TX_A, TX_B])
  })

  it('returns no hashes before the order is filled', async () => {
    const { fetchFn } = fakeFetch(() => json([]))
    expect(await fetchTradeHashes(UID, fetchFn)).toEqual([])
  })

  it('throws CowError when the trades lookup fails', async () => {
    const { fetchFn } = fakeFetch(() => json({ errorType: 'RateLimited', description: 'slow down' }, 429))
    const error = await errorOf(() => fetchTradeHashes(UID, fetchFn))
    expect(error.errorType).toBe('RateLimited')
  })
})

describe('every book call fails as CowError on a server error', () => {
  it.each([
    { endpoint: 'quote', run: (f: Fetch) => fetchQuote(QUOTE_REQUEST, f) },
    { endpoint: 'order submission', run: (f: Fetch) => submitOrder(submission(), f) },
    { endpoint: 'order status', run: (f: Fetch) => fetchOrder(UID, f) },
    { endpoint: 'account orders', run: (f: Fetch) => fetchOrders(owner, 50, f) },
    { endpoint: 'trades', run: (f: Fetch) => fetchTradeHashes(UID, f) },
  ])('the $endpoint call reports the HTTP status as the error type', async ({ run }) => {
    const { fetchFn } = fakeFetch(() => new Response('upstream failure', { status: 500 }))
    const error = await errorOf(() => run(fetchFn))
    expect(error.errorType).toBe('Http500')
    expect(error.message).toBe('upstream failure')
  })
})
