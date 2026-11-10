import { describe, expect, it } from 'vitest'
import {
  checkMove,
  deviationBps,
  feeBps,
  type MoveCheck,
  type Refusal,
  refusalText,
  toNumber,
} from '../../src/core/guard'
import type { Quote } from '../../src/core/order'
import { GOLD, USDT } from '../../src/core/tokens'

const HUNDRED_USDT = 100_000_000n
/** 0.025 PAXG at $4000 is $100, the market value of 100 USDT. */
const MARKET_BUY = 25_000_000_000_000_000n
/** Far above market, so the deviation rule cannot be the one that refuses. */
const GENEROUS_BUY = 50_000_000_000_000_000n

function quoteOf(sellAmount: bigint, feeAmount: bigint, buyAmount: bigint): Quote {
  return { sellToken: USDT.address, buyToken: GOLD.address, sellAmount, buyAmount, feeAmount, id: null }
}

function moveOf(quote: Quote, overrides: Partial<MoveCheck> = {}): MoveCheck {
  return {
    quote,
    balance: 1_000_000_000n,
    sellDecimals: 6,
    buyDecimals: 18,
    sellPriceUsd: 1,
    buyPriceUsd: 4000,
    ...overrides,
  }
}

describe('checkMove', () => {
  it('passes a move that clears every rule', () => {
    expect(checkMove(moveOf(quoteOf(HUNDRED_USDT, 0n, MARKET_BUY)))).toBeNull()
  })

  it('allows a move that uses the whole balance', () => {
    const check = moveOf(quoteOf(HUNDRED_USDT, 0n, MARKET_BUY), { balance: HUNDRED_USDT })
    expect(checkMove(check)).toBeNull()
  })

  it('refuses a move one unit above the balance', () => {
    const check = moveOf(quoteOf(HUNDRED_USDT, 0n, MARKET_BUY), { balance: HUNDRED_USDT - 1n })
    expect(checkMove(check)).toEqual({ code: 'exceeds-balance' })
  })

  it('allows a move worth exactly the $1 minimum', () => {
    const check = moveOf(quoteOf(1_000_000n, 0n, 250_000_000_000_000n))
    expect(checkMove(check)).toBeNull()
  })

  it('refuses a move one micro-dollar below the $1 minimum', () => {
    const check = moveOf(quoteOf(999_999n, 0n, 250_000_000_000_000n))
    expect(checkMove(check)).toEqual({ code: 'below-minimum', minUsd: 1 })
  })

  const feeRows: { bps: number; feeAmount: bigint; refusal: Refusal | null }[] = [
    { bps: 299, feeAmount: 2_990_000n, refusal: null },
    { bps: 300, feeAmount: 3_000_000n, refusal: null },
    { bps: 301, feeAmount: 3_010_000n, refusal: { code: 'fee-too-high', feeBps: 301 } },
  ]

  it.each(feeRows)('handles a network fee of $bps bps against the 300 bps limit', ({ feeAmount, refusal }) => {
    const check = moveOf(quoteOf(HUNDRED_USDT - feeAmount, feeAmount, GENEROUS_BUY))
    expect(checkMove(check)).toEqual(refusal)
  })

  // Known bug: feeBps truncates with bigint division, so a 3.001% fee reads as 300 bps and passes.
  it.fails('refuses a network fee of 3.001%, which is above the 3% limit (300.1 bps)', () => {
    const check = moveOf(quoteOf(HUNDRED_USDT - 3_001_000n, 3_001_000n, GENEROUS_BUY))
    expect(checkMove(check)).toMatchObject({ code: 'fee-too-high' })
  })

  const gapRows: { bps: number; buyAmount: bigint; refusal: Refusal | null }[] = [
    { bps: 149, buyAmount: 24_627_500_000_000_000n, refusal: null },
    { bps: 150, buyAmount: 24_625_000_000_000_000n, refusal: null },
    { bps: 151, buyAmount: 24_622_500_000_000_000n, refusal: { code: 'price-off-reference', deviationBps: 151 } },
  ]

  it.each(gapRows)('handles a price gap of $bps bps against the 150 bps limit', ({ buyAmount, refusal }) => {
    expect(checkMove(moveOf(quoteOf(HUNDRED_USDT, 0n, buyAmount)))).toEqual(refusal)
  })

  it('allows a quote that pays above the reference price', () => {
    const buyAbove = 27_500_000_000_000_000n
    expect(checkMove(moveOf(quoteOf(HUNDRED_USDT, 0n, buyAbove)))).toBeNull()
  })

  it.each([
    { side: 'sell', override: { sellPriceUsd: undefined } },
    { side: 'buy', override: { buyPriceUsd: undefined } },
  ])('refuses a move when the $side price is unknown', ({ override }) => {
    const check = moveOf(quoteOf(HUNDRED_USDT, 0n, MARKET_BUY), override)
    expect(checkMove(check)).toEqual({ code: 'no-reference-price' })
  })

  it('reports an exceeded balance before a missing price', () => {
    const check = moveOf(quoteOf(HUNDRED_USDT, 0n, MARKET_BUY), { balance: 0n, sellPriceUsd: undefined })
    expect(checkMove(check)).toEqual({ code: 'exceeds-balance' })
  })

  it('reports a missing price before the minimum size', () => {
    const check = moveOf(quoteOf(500_000n, 0n, MARKET_BUY), { sellPriceUsd: undefined })
    expect(checkMove(check)).toEqual({ code: 'no-reference-price' })
  })

  it('reports the minimum size before the fee', () => {
    const check = moveOf(quoteOf(250_000n, 250_000n, GENEROUS_BUY))
    expect(checkMove(check)).toEqual({ code: 'below-minimum', minUsd: 1 })
  })

  it('reports the fee before the price gap', () => {
    const check = moveOf(quoteOf(96_000_000n, 4_000_000n, 0n))
    expect(checkMove(check)).toEqual({ code: 'fee-too-high', feeBps: 400 })
  })
})

describe('toNumber', () => {
  it.each([
    { units: 2_500_000_000_000_000_000n, decimals: 18, expected: 2.5 },
    { units: 12_000_000n, decimals: 6, expected: 12 },
    { units: 1n, decimals: 8, expected: 1e-8 },
    { units: 0n, decimals: 18, expected: 0 },
  ])('converts $units units with $decimals decimals to $expected', ({ units, decimals, expected }) => {
    expect(toNumber(units, decimals)).toBe(expected)
  })
})

describe('feeBps', () => {
  it.each([
    { sellAmount: 97n, feeAmount: 3n, bps: 300 },
    { sellAmount: 2n, feeAmount: 1n, bps: 3333 },
    { sellAmount: 5n, feeAmount: 0n, bps: 0 },
    { sellAmount: 0n, feeAmount: 0n, bps: 0 },
  ])('reads a fee of $feeAmount on $sellAmount sold as $bps bps', ({ sellAmount, feeAmount, bps }) => {
    expect(feeBps(quoteOf(sellAmount, feeAmount, 0n))).toBe(bps)
  })
})

describe('deviationBps', () => {
  it('reports no deviation when nothing is sold', () => {
    expect(deviationBps(moveOf(quoteOf(0n, 0n, 5n)))).toBe(0)
  })

  it('reports a full 10000 bps shortfall when nothing comes back', () => {
    expect(deviationBps(moveOf(quoteOf(HUNDRED_USDT, 0n, 0n)))).toBe(10_000)
  })

  it('reports a negative deviation when the quote pays above the reference price', () => {
    expect(deviationBps(moveOf(quoteOf(HUNDRED_USDT, 0n, 27_500_000_000_000_000n)))).toBe(-1000)
  })

  // Known bug: the sold side includes the network fee, but buyAmount is quoted for the net sellAmount.
  it.fails('does not count the network fee as a price gap when the quote is at market', () => {
    const check = moveOf(quoteOf(98_000_000n, 2_000_000n, 24_500_000_000_000_000n))
    expect(deviationBps(check)).toBe(0)
  })
})

describe('refusalText', () => {
  const cases: { refusal: Refusal; names: string }[] = [
    { refusal: { code: 'below-minimum', minUsd: 1 }, names: '$1' },
    { refusal: { code: 'fee-too-high', feeBps: 350 }, names: '3.5%' },
    { refusal: { code: 'price-off-reference', deviationBps: 250 }, names: '2.5%' },
  ]

  it.each(cases)('explains the refusal and names the number $names', ({ refusal, names }) => {
    expect(refusalText(refusal)).toContain(names)
  })

  it('says a move is more than the wallet holds', () => {
    expect(refusalText({ code: 'exceeds-balance' })).toContain('more than the wallet holds')
  })

  it('says the market price is unavailable', () => {
    expect(refusalText({ code: 'no-reference-price' })).toContain('market price is unavailable')
  })
})
