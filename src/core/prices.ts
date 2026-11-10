import type { Fetch } from './cow'
import { ALL_TOKENS, type HoldingId } from './tokens'

export type FiatCode = 'USD' | 'EUR' | 'CRC'
export const FIAT_CODES: readonly FiatCode[] = ['USD', 'EUR', 'CRC']

export type PricedId = HoldingId | 'nim'

/** Reference price of one whole unit of each holding, per currency. */
export type PriceTable = Record<PricedId, Partial<Record<FiatCode, number>>>

export const NIM_PRICE_ID = 'nimiq-2'
export type PriceSource = 'CoinGecko' | 'DefiLlama'

const PRICE_IDS: Record<PricedId, string> = {
  ...(Object.fromEntries(ALL_TOKENS.map((t) => [t.id, t.priceId])) as Record<HoldingId, string>),
  nim: NIM_PRICE_ID,
}
const PRICED = Object.keys(PRICE_IDS) as PricedId[]

function emptyTable(): PriceTable {
  return { usdt: {}, gold: {}, euro: {}, bitcoin: {}, nim: {} }
}

function positive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

export function priceUrl(): string {
  const ids = Object.values(PRICE_IDS).join(',')
  const vs = FIAT_CODES.map((c) => c.toLowerCase()).join(',')
  return `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs}`
}

/** Reads the price response. A missing or non-positive price is left out. */
export function parsePrices(body: unknown): PriceTable {
  const table = emptyTable()
  if (typeof body !== 'object' || body === null) return table
  const rows = body as Record<string, unknown>
  for (const key of PRICED) {
    const row = rows[PRICE_IDS[key]]
    if (typeof row !== 'object' || row === null) continue
    for (const code of FIAT_CODES) {
      const v = positive((row as Record<string, unknown>)[code.toLowerCase()])
      if (v !== undefined) table[key][code] = v
    }
  }
  return table
}

export function fallbackPriceUrl(): string {
  const ids = Object.values(PRICE_IDS).map((id) => `coingecko:${id}`)
  return `https://coins.llama.fi/prices/current/${ids.join(',')}`
}

/**
 * Reads the second source, which quotes in US dollars. Euro values use its
 * EURe price, since one EURe is one euro.
 */
export function parseFallbackPrices(body: unknown): PriceTable {
  const table = emptyTable()
  const coins = (body as { coins?: Record<string, { price?: unknown } | null> } | null)?.coins
  if (typeof coins !== 'object' || coins === null) return table
  const usd = (key: PricedId): number | undefined => positive(coins[`coingecko:${PRICE_IDS[key]}`]?.price)
  const euroUsd = usd('euro')
  for (const key of PRICED) {
    const price = usd(key)
    if (price === undefined) continue
    table[key].USD = price
    if (euroUsd !== undefined) table[key].EUR = price / euroUsd
  }
  return table
}

export interface Prices {
  table: PriceTable
  source: PriceSource
}

function complete(table: PriceTable): boolean {
  return PRICED.every((key) => table[key].USD !== undefined)
}

/** Reference prices from CoinGecko, or from DefiLlama when CoinGecko fails or misses a holding. */
export async function fetchPrices(fetchFn: Fetch = fetch): Promise<Prices> {
  let failure = 'Price source gave no prices'
  try {
    const res = await fetchFn(priceUrl())
    if (res.ok) {
      const table = parsePrices(await res.json())
      if (complete(table)) return { table, source: 'CoinGecko' }
    } else {
      failure = `Price source answered ${res.status}`
    }
  } catch (err) {
    failure = (err as Error).message
  }
  const res = await fetchFn(fallbackPriceUrl())
  if (!res.ok) throw new Error(failure)
  const table = parseFallbackPrices(await res.json())
  if (!complete(table)) throw new Error(failure)
  return { table, source: 'DefiLlama' }
}

/**
 * The statement currency: the phone's own when the table prices it, else US
 * dollars.
 */
export function statementFiat(hostFiat: string | undefined, table?: PriceTable | null): FiatCode {
  const code = FIAT_CODES.find((c) => c === hostFiat) ?? 'USD'
  return table && table.usdt[code] === undefined ? 'USD' : code
}
