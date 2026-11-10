import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { formatFiat, formatPercent, formatUnitsFixed, parseAmount, shortAddress } from '../../src/core/format'

describe('parseAmount', () => {
  it.each([
    { text: '1', decimals: 6, units: 1_000_000n },
    { text: '0.5', decimals: 6, units: 500_000n },
    { text: '.5', decimals: 6, units: 500_000n },
    { text: '5.', decimals: 6, units: 5_000_000n },
    { text: '12,34', decimals: 6, units: 12_340_000n },
    { text: '  25  ', decimals: 6, units: 25_000_000n },
    { text: '0.000001', decimals: 6, units: 1n },
    { text: '0', decimals: 6, units: 0n },
    { text: '0.00012345', decimals: 8, units: 12_345n },
    { text: '1.5', decimals: 18, units: 1_500_000_000_000_000_000n },
    { text: '7', decimals: 0, units: 7n },
  ])('reads "$text" at $decimals decimals as $units units', ({ text, decimals, units }) => {
    expect(parseAmount(text, decimals)).toBe(units)
  })

  it.each(['', '.', 'abc', '1e6', '-1', '+1', '1.2.3', '1 000', '$5', '0x10'])('reads "%s" as no amount', (text) => {
    expect(parseAmount(text, 6)).toBeNull()
  })

  it('refuses more decimal places than the token has', () => {
    expect(parseAmount('0.0000001', 6)).toBeNull()
  })

  it('reads back every amount it formats at full precision', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.integer({ min: 0, max: 18 }), (units, decimals) => {
        const text = formatUnitsFixed(units, decimals, decimals).replace(/,/g, '')
        expect(parseAmount(text, decimals)).toBe(units)
      }),
    )
  })
})

describe('formatUnitsFixed', () => {
  it.each([
    { amount: 1_234_567n, decimals: 6, places: 2, text: '1.23' },
    { amount: 1_999_999n, decimals: 6, places: 2, text: '1.99' },
    { amount: 1_000_000n, decimals: 6, places: 2, text: '1.00' },
    { amount: 0n, decimals: 18, places: 5, text: '0.00000' },
    { amount: 1_234_567_890_000n, decimals: 6, places: 2, text: '1,234,567.89' },
    { amount: 123_456n, decimals: 8, places: 6, text: '0.001234' },
    { amount: 1_500_000n, decimals: 6, places: 0, text: '1' },
    { amount: 5n, decimals: 0, places: 2, text: '5.00' },
  ])('writes $amount units at $decimals decimals as $text', ({ amount, decimals, places, text }) => {
    expect(formatUnitsFixed(amount, decimals, places)).toBe(text)
  })

  it('never shows more than the amount held', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 24n }), fc.integer({ min: 0, max: 6 }), (units, places) => {
        const shown = parseAmount(formatUnitsFixed(units, 6, places).replace(/,/g, ''), 6)
        expect(shown).not.toBeNull()
        expect(shown!).toBeLessThanOrEqual(units)
      }),
    )
  })
})

describe('formatFiat', () => {
  it.each([
    { value: 1234.5, fiat: 'USD', text: '$1,234.50' },
    { value: 0, fiat: 'USD', text: '$0.00' },
    { value: 0.004, fiat: 'USD', text: '$0.00' },
    { value: 99.999, fiat: 'EUR', text: '€100.00' },
    { value: 1_234_567.4, fiat: 'CRC', text: '₡1,234,567' },
    { value: -12.3, fiat: 'EUR', text: '-€12.30' },
  ] as const)('writes $value $fiat as $text', ({ value, fiat, text }) => {
    expect(formatFiat(value, fiat)).toBe(text)
  })

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])('writes %s as n/a', (value) => {
    expect(formatFiat(value, 'USD')).toBe('n/a')
  })
})

describe('formatPercent', () => {
  it.each([
    { share: 0, text: '0%' },
    { share: 0.034, text: '3.4%' },
    { share: 0.1, text: '10%' },
    { share: 0.456, text: '46%' },
    { share: 1, text: '100%' },
  ])('writes a share of $share as $text', ({ share, text }) => {
    expect(formatPercent(share)).toBe(text)
  })
})

describe('shortAddress', () => {
  it('keeps the first six and last four characters of an address', () => {
    expect(shortAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')).toBe('0x7099…79C8')
  })

  it('leaves a short text whole', () => {
    expect(shortAddress('0x1234')).toBe('0x1234')
  })
})
