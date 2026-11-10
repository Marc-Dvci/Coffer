import { describe, expect, it } from 'vitest'
import { fallbackPriceUrl, fetchPrices, parseFallbackPrices, parsePrices, priceUrl, statementFiat } from '../../src/core/prices'
import { at, fakeFetch, json } from './helpers'

const BODY = {
  tether: { usd: 1, eur: 0.86, crc: 505 },
  'pax-gold': { usd: 4100, eur: 3530, crc: 2_070_000 },
  'monerium-eur-money': { usd: 1.16, eur: 1, crc: 586 },
  'wrapped-bitcoin': { usd: 104_000, eur: 89_500, crc: 52_500_000 },
  'nimiq-2': { usd: 0.0009, eur: 0.00077, crc: 0.45 },
}

describe('priceUrl', () => {
  it('asks for every holding and NIM in dollars, euros and colones', () => {
    const url = new URL(priceUrl())
    expect(url.origin + url.pathname).toBe('https://api.coingecko.com/api/v3/simple/price')
    expect(url.searchParams.get('ids')?.split(',').sort()).toEqual(Object.keys(BODY).sort())
    expect(url.searchParams.get('vs_currencies')).toBe('usd,eur,crc')
  })
})

describe('parsePrices', () => {
  it('reads one price per holding and currency', () => {
    expect(parsePrices(BODY)).toEqual({
      usdt: { USD: 1, EUR: 0.86, CRC: 505 },
      gold: { USD: 4100, EUR: 3530, CRC: 2_070_000 },
      euro: { USD: 1.16, EUR: 1, CRC: 586 },
      bitcoin: { USD: 104_000, EUR: 89_500, CRC: 52_500_000 },
      nim: { USD: 0.0009, EUR: 0.00077, CRC: 0.45 },
    })
  })

  it.each([
    { name: 'zero', value: 0 },
    { name: 'negative', value: -5 },
    { name: 'text', value: '4100' },
    { name: 'not finite', value: Number.POSITIVE_INFINITY },
    { name: 'null', value: null },
  ])('leaves out a $name price', ({ value }) => {
    const table = parsePrices({ ...BODY, 'pax-gold': { usd: value, eur: 3530 } })
    expect(table.gold).toEqual({ EUR: 3530 })
  })

  it('leaves a holding empty when its row is missing or malformed', () => {
    const table = parsePrices({ tether: { usd: 1 }, 'pax-gold': 'n/a', 'wrapped-bitcoin': null })
    expect(table).toEqual({ usdt: { USD: 1 }, gold: {}, euro: {}, bitcoin: {}, nim: {} })
  })

  it.each([null, undefined, 'error', 42])('reads %s as an empty table', (body) => {
    expect(parsePrices(body)).toEqual({ usdt: {}, gold: {}, euro: {}, bitcoin: {}, nim: {} })
  })
})

/** The second source's answer shape, with prices in US dollars. */
const FALLBACK_BODY = {
  coins: {
    'coingecko:tether': { price: 1, symbol: 'USDT' },
    'coingecko:pax-gold': { price: 4060, symbol: 'PAXG' },
    'coingecko:monerium-eur-money': { price: 1.16, symbol: 'EURE' },
    'coingecko:wrapped-bitcoin': { price: 104_400, symbol: 'WBTC' },
    'coingecko:nimiq-2': { price: 0.00087, symbol: 'NIM' },
  },
}

describe('parseFallbackPrices', () => {
  it('reads dollar prices and derives euro prices from the EURe price', () => {
    const table = parseFallbackPrices(FALLBACK_BODY)
    expect(table.gold.USD).toBe(4060)
    expect(table.gold.EUR).toBeCloseTo(3500, 6)
    expect(table.euro).toEqual({ USD: 1.16, EUR: 1 })
    expect(table.bitcoin.EUR).toBeCloseTo(90_000, 6)
  })

  it('gives dollar prices only when the EURe price is missing', () => {
    const coins = { ...FALLBACK_BODY.coins, 'coingecko:monerium-eur-money': null }
    const table = parseFallbackPrices({ coins })
    expect(table.gold).toEqual({ USD: 4060 })
    expect(table.euro).toEqual({})
  })

  it.each([0, -1, '4060', null])('leaves out a price of %j', (price) => {
    const coins = { ...FALLBACK_BODY.coins, 'coingecko:pax-gold': { price } }
    expect(parseFallbackPrices({ coins }).gold).toEqual({})
  })

  it.each([null, {}, { coins: null }, 'error'])('reads %j as an empty table', (body) => {
    expect(parseFallbackPrices(body)).toEqual({ usdt: {}, gold: {}, euro: {}, bitcoin: {}, nim: {} })
  })
})

describe('fetchPrices', () => {
  const unreachable = (): Response => {
    throw new TypeError('Failed to fetch')
  }
  const answer = (primary: () => Response, fallback: () => Response = () => json(FALLBACK_BODY)) =>
    fakeFetch((url) => (url === priceUrl() ? primary() : fallback()))

  it('reads the table from CoinGecko with one request', async () => {
    const { fetchFn, calls } = answer(() => json(BODY))
    const prices = await fetchPrices(fetchFn)
    expect(prices.source).toBe('CoinGecko')
    expect(prices.table.gold.USD).toBe(4100)
    expect(calls.map((c) => c.url)).toEqual([priceUrl()])
  })

  it('reads the table from DefiLlama when CoinGecko refuses', async () => {
    const { fetchFn, calls } = answer(() => json({}, 429))
    const prices = await fetchPrices(fetchFn)
    expect(prices.source).toBe('DefiLlama')
    expect(prices.table.gold.USD).toBe(4060)
    expect(at(calls, 1).url).toBe(fallbackPriceUrl())
  })

  it('reads the table from DefiLlama when CoinGecko is unreachable', async () => {
    const { fetchFn } = answer(unreachable)
    expect((await fetchPrices(fetchFn)).source).toBe('DefiLlama')
  })

  it('reads the table from DefiLlama when CoinGecko misses a holding', async () => {
    const { fetchFn } = answer(() => json({ ...BODY, 'pax-gold': {} }))
    expect((await fetchPrices(fetchFn)).source).toBe('DefiLlama')
  })

  it('fails with the CoinGecko status when both sources refuse', async () => {
    const { fetchFn } = answer(
      () => json({}, 429),
      () => json({}, 500),
    )
    await expect(fetchPrices(fetchFn)).rejects.toThrow('Price source answered 429')
  })

  it('fails when the second source misses a holding too', async () => {
    const { fetchFn } = answer(
      () => json({}, 503),
      () => json({ coins: {} }),
    )
    await expect(fetchPrices(fetchFn)).rejects.toThrow('Price source answered 503')
  })

  it('fails with the network error when CoinGecko is unreachable and the second source refuses', async () => {
    const { fetchFn } = answer(unreachable, () => json({}, 500))
    await expect(fetchPrices(fetchFn)).rejects.toThrow('Failed to fetch')
  })

  it('fails when CoinGecko answers with no prices and the second source refuses', async () => {
    const { fetchFn } = answer(
      () => json({}),
      () => json({}, 500),
    )
    await expect(fetchPrices(fetchFn)).rejects.toThrow('Price source gave no prices')
  })
})

describe('statementFiat with a price table', () => {
  it('keeps the phone currency when the table prices it', () => {
    expect(statementFiat('EUR', parsePrices(BODY))).toBe('EUR')
  })

  it('falls back to US dollars when the table has no price in the phone currency', () => {
    expect(statementFiat('CRC', parseFallbackPrices(FALLBACK_BODY))).toBe('USD')
  })
})

describe('statementFiat', () => {
  it.each(['USD', 'EUR', 'CRC'] as const)('keeps the phone currency %s', (code) => {
    expect(statementFiat(code)).toBe(code)
  })

  it.each([undefined, 'GBP', 'eur', ''])('falls back to US dollars for %s', (code) => {
    expect(statementFiat(code)).toBe('USD')
  })
})
