import { describe, expect, it } from 'vitest'
import type { PriceTable } from '../../src/core/prices'
import { type Balances, buildStatement } from '../../src/core/statement'
import { at } from './helpers'

const PRICES: PriceTable = {
  usdt: { USD: 1, EUR: 0.9 },
  gold: { USD: 4000, EUR: 3600 },
  euro: { USD: 1.1, EUR: 1 },
  bitcoin: { USD: 100_000, EUR: 90_000 },
  nim: { USD: 0.001, EUR: 0.0009 },
}

const BALANCES: Balances = {
  tokens: {
    usdt: 200_000_000n,
    gold: 25_000_000_000_000_000n,
    euro: 100n * 10n ** 18n,
    bitcoin: 100_000n,
  },
  nimLuna: 50_000_00000n,
  stakedLuna: 150_000_00000n,
}

const EMPTY: Balances = { tokens: {}, nimLuna: 0n, stakedLuna: 0n }

describe('buildStatement', () => {
  it('lists savings first, then dollars, NIM and staked NIM', () => {
    const st = buildStatement(BALANCES, PRICES, 'USD')
    expect(st.rows.map((r) => r.id)).toEqual(['gold', 'euro', 'bitcoin', 'usdt', 'nim', 'staked'])
    expect(st.rows.map((r) => r.label)).toEqual(['Gold', 'Euros', 'Bitcoin', 'Dollars', 'NIM', 'NIM that earns'])
  })

  it('values each holding at its reference price', () => {
    const st = buildStatement(BALANCES, PRICES, 'USD')
    expect(st.rows.map((r) => [r.amount, r.value])).toEqual([
      [0.025, 100],
      [100, 110.00000000000001],
      [0.001, 100],
      [200, 200],
      [50_000, 50],
      [150_000, 150],
    ])
  })

  it('totals every row', () => {
    expect(buildStatement(BALANCES, PRICES, 'USD').total).toBeCloseTo(710, 9)
  })

  it('gives the share held in gold, euros and bitcoin', () => {
    expect(buildStatement(BALANCES, PRICES, 'USD').savedShare).toBeCloseTo(310 / 710, 9)
  })

  it('values the same holdings in the statement currency', () => {
    const st = buildStatement(BALANCES, PRICES, 'EUR')
    expect(st.fiat).toBe('EUR')
    expect(st.total).toBeCloseTo(90 + 100 + 90 + 180 + 45 + 135, 9)
  })

  it('reads an empty wallet as zero with no saved share', () => {
    const st = buildStatement(EMPTY, PRICES, 'USD')
    expect(st.total).toBe(0)
    expect(st.savedShare).toBe(0)
    expect(st.rows.every((r) => r.amount === 0 && r.value === 0)).toBe(true)
  })

  it('leaves a holding unvalued and out of the total when its price is missing', () => {
    const st = buildStatement(BALANCES, { ...PRICES, gold: {} }, 'USD')
    expect(at(st.rows, 0)).toMatchObject({ id: 'gold', amount: 0.025, value: undefined })
    expect(st.total).toBeCloseTo(610, 9)
    expect(st.savedShare).toBeCloseTo(210 / 610, 9)
  })

  it('leaves every row unvalued in a currency with no prices', () => {
    const st = buildStatement(BALANCES, PRICES, 'CRC')
    expect(st.rows.every((r) => r.value === undefined)).toBe(true)
    expect(st.total).toBe(0)
  })

  it('counts NIM and staked NIM outside the saved share', () => {
    const st = buildStatement({ tokens: {}, nimLuna: 100_000_00000n, stakedLuna: 0n }, PRICES, 'USD')
    expect(st.total).toBeCloseTo(100, 9)
    expect(st.savedShare).toBe(0)
  })
})
