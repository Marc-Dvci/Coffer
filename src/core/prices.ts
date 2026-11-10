import type { Fetch } from './cow'
import { ALL_TOKENS, type HoldingId } from './tokens'

export type FiatCode = 'USD' | 'EUR' | 'CRC'
export const FIAT_CODES: readonly FiatCode[] = ['USD', 'EUR', 'CRC']

export type PricedId = HoldingId | 'nim'

/** Reference price of one whole unit of each holding, per currency. */
export type PriceTable = Record<PricedId, Partial<Record<FiatCode, number>>>

export const NIM_PRICE_ID = 'nimiq-2'
export const PRICE_SOURCE = 'CoinGecko'

const PRICE_IDS: Record<PricedId, string> = {
  ...(Object.fromEntries(ALL_TOKENS.map((t) => [t.id, t.priceId])) as Record<HoldingId, string>),
  nim: NIM_PRICE_ID,
}

export function priceUrl(): string {
  const ids = Object.values(PRICE_IDS).join(',')
  const vs = FIAT_CODES.map((c) => c.toLowerCase()).join(',')
  return `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs}`
}

/** Reads the price response. A missing or non-positive price is left out. */
export function parsePrices(body: unknown): PriceTable {
  const table = { usdt: {}, gold: {}, euro: {}, bitcoin: {}, nim: {} } as PriceTable
  if (typeof body !== 'object' || body === null) return table
  const rows = body as Record<string, unknown>
  for (const key of Object.keys(PRICE_IDS) as PricedId[]) {
    const row = rows[PRICE_IDS[key]]
    if (typeof row !== 'object' || row === null) continue
    for (const code of FIAT_CODES) {
      const v = (row as Record<string, unknown>)[code.toLowerCase()]
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) table[key][code] = v
    }
  }
  return table
}

export async function fetchPrices(fetchFn: Fetch = fetch): Promise<PriceTable> {
  const res = await fetchFn(priceUrl())
  if (!res.ok) throw new Error(`Price source answered ${res.status}`)
  return parsePrices(await res.json())
}

/** The statement currency: the phone's own when a price exists for it, else US dollars. */
export function statementFiat(hostFiat: string | undefined): FiatCode {
  return FIAT_CODES.find((c) => c === hostFiat) ?? 'USD'
}
