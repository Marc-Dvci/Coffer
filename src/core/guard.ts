import type { Quote } from './order'

/** Limits a move must pass before the wallet is asked to sign. */
export const LIMITS = {
  /** Smallest move, in US dollars. */
  minUsd: 1,
  /** Largest share of the amount the network fee may take, in basis points. */
  maxFeeBps: 300,
  /** Largest gap below the reference price the quote may show, in basis points. */
  maxDeviationBps: 150,
  /** Slippage written into the order, in basis points. */
  slippageBps: 50,
} as const

export type Refusal =
  | { code: 'below-minimum'; minUsd: number }
  | { code: 'exceeds-balance' }
  | { code: 'fee-too-high'; feeBps: number }
  | { code: 'price-off-reference'; deviationBps: number }
  | { code: 'no-reference-price' }

export interface MoveCheck {
  quote: Quote
  /** Balance of the sold token, in token units. */
  balance: bigint
  sellDecimals: number
  buyDecimals: number
  /** Reference prices in US dollars per whole token. */
  sellPriceUsd: number | undefined
  buyPriceUsd: number | undefined
}

/** Converts token units to a number of whole tokens. Exact to 15 digits. */
export function toNumber(amount: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals)
  const whole = amount / scale
  const frac = amount % scale
  return Number(whole) + Number(frac) / Number(scale)
}

/** Basis points by which the quoted amount falls short of the reference value. */
export function deviationBps(check: MoveCheck): number {
  const { quote } = check
  const soldUsd =
    toNumber(quote.sellAmount + quote.feeAmount, check.sellDecimals) * (check.sellPriceUsd ?? 0)
  const boughtUsd = toNumber(quote.buyAmount, check.buyDecimals) * (check.buyPriceUsd ?? 0)
  if (soldUsd <= 0) return 0
  return Math.round(((soldUsd - boughtUsd) / soldUsd) * 10_000)
}

/** Network fee as basis points of the amount sold. */
export function feeBps(quote: Quote): number {
  const total = quote.sellAmount + quote.feeAmount
  if (total <= 0n) return 0
  return Number((quote.feeAmount * 10_000n) / total)
}

/**
 * Decides whether a quoted move may be signed. Returns the first rule the
 * move breaks, or null when it passes every rule.
 */
export function checkMove(check: MoveCheck): Refusal | null {
  const { quote } = check
  const total = quote.sellAmount + quote.feeAmount
  if (total > check.balance) return { code: 'exceeds-balance' }
  if (check.sellPriceUsd === undefined || check.buyPriceUsd === undefined) {
    return { code: 'no-reference-price' }
  }
  const usd = toNumber(total, check.sellDecimals) * check.sellPriceUsd
  if (usd < LIMITS.minUsd) return { code: 'below-minimum', minUsd: LIMITS.minUsd }
  const fee = feeBps(quote)
  if (fee > LIMITS.maxFeeBps) return { code: 'fee-too-high', feeBps: fee }
  const dev = deviationBps(check)
  if (dev > LIMITS.maxDeviationBps) return { code: 'price-off-reference', deviationBps: dev }
  return null
}

export function refusalText(r: Refusal): string {
  switch (r.code) {
    case 'below-minimum':
      return `The smallest move is $${r.minUsd}.`
    case 'exceeds-balance':
      return 'This is more than the wallet holds.'
    case 'fee-too-high':
      return `The network fee would take ${(r.feeBps / 100).toFixed(1)}% of this amount. Move a larger amount.`
    case 'price-off-reference':
      return `This quote is ${(r.deviationBps / 100).toFixed(1)}% below the market price. Move a smaller amount.`
    case 'no-reference-price':
      return 'The market price is unavailable, so this quote cannot be checked. Try again shortly.'
  }
}
