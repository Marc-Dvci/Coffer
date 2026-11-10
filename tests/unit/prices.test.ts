import { describe, expect, it } from 'vitest'
import { fetchPrices, parsePrices, priceUrl, statementFiat } from '../../src/core/prices'
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

describe('fetchPrices', () => {
  it('reads the table from the price source', async () => {
    const { fetchFn, calls } = fakeFetch(() => json(BODY))
    expect((await fetchPrices(fetchFn)).gold.USD).toBe(4100)
    expect(at(calls, 0).url).toBe(priceUrl())
  })

  it('fails with the status when the price source refuses', async () => {
    const { fetchFn } = fakeFetch(() => json({}, 429))
    await expect(fetchPrices(fetchFn)).rejects.toThrow('Price source answered 429')
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
