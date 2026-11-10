import type { Fetch } from './cow'

export const VALIDATORS_API = 'https://validators-api-main.je-cf9.workers.dev/api/v1/validators'
export const NIMIQ_RPC = 'https://rpc.nimiqwatch.com'

/** Smallest stake the network accepts for a new staker, in Luna (100 NIM). */
export const MIN_STAKE_LUNA = 10_000_000n

export interface Validator {
  address: string
  name: string
  /** Share of rewards the pool keeps, from 0 to 1. */
  fee: number
  /** Trust score from 0 to 1: availability, reliability and stake dominance. */
  score: number
  /** How rewards reach the staker. */
  payout: string
}

/** Reads the validator list. Entries without a name, fee or score are left out. */
export function parseValidators(body: unknown): Validator[] {
  if (!Array.isArray(body)) return []
  const out: Validator[] = []
  for (const raw of body as Record<string, unknown>[]) {
    const score = (raw?.score as { total?: unknown } | null)?.total
    if (
      typeof raw?.address !== 'string' ||
      typeof raw.name !== 'string' ||
      raw.name === '' ||
      typeof raw.fee !== 'number' ||
      typeof score !== 'number'
    ) {
      continue
    }
    out.push({
      address: raw.address,
      name: raw.name,
      fee: raw.fee,
      score,
      payout: typeof raw.payoutType === 'string' ? raw.payoutType : 'none',
    })
  }
  return rankValidators(out)
}

/**
 * Orders pools for a saver: only pools that pay rewards back to the staker,
 * highest trust score first, lowest fee as the tie-break.
 */
export function rankValidators(list: readonly Validator[]): Validator[] {
  return list
    .filter((v) => v.payout !== 'none' && v.score >= 0.9)
    .slice()
    .sort((a, b) => Math.round((b.score - a.score) * 1000) || a.fee - b.fee || a.name.localeCompare(b.name))
}

export async function fetchValidators(fetchFn: Fetch = fetch): Promise<Validator[]> {
  const res = await fetchFn(VALIDATORS_API)
  if (!res.ok) throw new Error(`Validator list answered ${res.status}`)
  return parseValidators(await res.json())
}

export interface Staker {
  /** Active stake in Luna. */
  balanceLuna: bigint
  /** Stake being withdrawn, in Luna. */
  inactiveLuna: bigint
  validator: string | null
}

/** Reads a staker record from a `getStakerByAddress` response. Null when there is none. */
export function parseStaker(body: unknown): Staker | null {
  const data = (body as { result?: { data?: Record<string, unknown> } } | null)?.result?.data
  if (!data || typeof data !== 'object') return null
  const num = (v: unknown): bigint => (typeof v === 'number' && v > 0 ? BigInt(Math.trunc(v)) : 0n)
  return {
    balanceLuna: num(data.balance),
    inactiveLuna: num(data.inactiveBalance) + num(data.retiredBalance),
    validator: typeof data.delegation === 'string' ? data.delegation : null,
  }
}

export async function fetchStaker(address: string, fetchFn: Fetch = fetch): Promise<Staker | null> {
  const res = await fetchFn(NIMIQ_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getStakerByAddress', params: [address] }),
  })
  if (!res.ok) throw new Error(`Nimiq RPC answered ${res.status}`)
  return parseStaker(await res.json())
}
