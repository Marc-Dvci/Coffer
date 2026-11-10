import { toNumber } from './guard'
import type { FiatCode, PricedId, PriceTable } from './prices'
import { ALL_TOKENS, type HoldingId } from './tokens'

/** NIM has 5 decimals; its smallest unit is the Luna. */
export const NIM_DECIMALS = 5

export interface Balances {
  /** Token units per holding on Polygon. */
  tokens: Partial<Record<HoldingId, bigint>>
  /** Spendable NIM in Luna, wallet address plus HTLC address. */
  nimLuna: bigint
  /** Staked NIM in Luna. */
  stakedLuna: bigint
}

export interface StatementRow {
  id: PricedId | 'staked'
  label: string
  /** Whole units held. */
  amount: number
  /** Value in the statement currency, when a price exists. */
  value: number | undefined
}

export interface Statement {
  fiat: FiatCode
  rows: StatementRow[]
  /** Sum of every row that has a value. */
  total: number
  /** Share of the total held outside dollars and NIM, from 0 to 1. */
  savedShare: number
}

function value(amount: number, price: number | undefined): number | undefined {
  return price === undefined ? undefined : amount * price
}

/** Everything the wallet holds, valued in one currency. */
export function buildStatement(balances: Balances, prices: PriceTable, fiat: FiatCode): Statement {
  const rows: StatementRow[] = []
  for (const id of ['gold', 'euro', 'bitcoin', 'usdt'] as const) {
    const token = ALL_TOKENS.find((t) => t.id === id)!
    const amount = toNumber(balances.tokens[id] ?? 0n, token.decimals)
    rows.push({ id, label: token.label, amount, value: value(amount, prices[id][fiat]) })
  }
  const nim = toNumber(balances.nimLuna, NIM_DECIMALS)
  const staked = toNumber(balances.stakedLuna, NIM_DECIMALS)
  rows.push({ id: 'nim', label: 'NIM', amount: nim, value: value(nim, prices.nim[fiat]) })
  rows.push({
    id: 'staked',
    label: 'NIM that earns',
    amount: staked,
    value: value(staked, prices.nim[fiat]),
  })
  const total = rows.reduce((sum, r) => sum + (r.value ?? 0), 0)
  const saved = rows
    .filter((r) => r.id === 'gold' || r.id === 'euro' || r.id === 'bitcoin')
    .reduce((sum, r) => sum + (r.value ?? 0), 0)
  return { fiat, rows, total, savedShare: total > 0 ? saved / total : 0 }
}
