import type { FiatCode } from './prices'

/** Parses what a person typed into token units. Returns null when it is not an amount. */
export function parseAmount(text: string, decimals: number): bigint | null {
  const clean = text.trim().replace(',', '.')
  if (!/^\d*\.?\d*$/.test(clean) || clean === '' || clean === '.') return null
  const [whole = '', frac = ''] = clean.split('.')
  if (frac.length > decimals) return null
  const units = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
  return units
}

/** Token units as a decimal string, cut (never rounded up) to `places`. */
export function formatUnitsFixed(amount: bigint, decimals: number, places: number): string {
  const scale = 10n ** BigInt(decimals)
  const whole = amount / scale
  const frac = (amount % scale).toString().padStart(decimals, '0').slice(0, places)
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return places > 0 ? `${grouped}.${frac.padEnd(places, '0')}` : grouped
}

const FIAT_PLACES: Record<FiatCode, number> = { USD: 2, EUR: 2, CRC: 0 }
const FIAT_SIGN: Record<FiatCode, string> = { USD: '$', EUR: '€', CRC: '₡' }

export function formatFiat(value: number | undefined, fiat: FiatCode): string {
  if (value === undefined || !Number.isFinite(value)) return 'n/a'
  const places = FIAT_PLACES[fiat]
  const fixed = Math.abs(value).toFixed(places)
  const [whole = '0', frac] = fixed.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${value < 0 ? '-' : ''}${FIAT_SIGN[fiat]}${grouped}${frac ? `.${frac}` : ''}`
}

export function formatPercent(share: number): string {
  return `${(share * 100).toFixed(share > 0 && share < 0.1 ? 1 : 0)}%`
}

/** `0x1234…abcd` */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}
