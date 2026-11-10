import { getHostFiat, init, type NimiqProvider } from '@nimiq/mini-app-sdk'
import { fetchStaker, type Staker } from '../core/staking'

export interface NimiqSession {
  provider: NimiqProvider
  /** Wallet address first, then the HTLC address that holds spendable NIM. */
  accounts: string[]
}

/** True when the page runs inside Nimiq Pay. */
export function insideNimiqPay(): boolean {
  return typeof window !== 'undefined' && (window.nimiq !== undefined || window.nimiqPay !== undefined)
}

export function hostFiat(): string | undefined {
  try {
    return getHostFiat()
  } catch {
    return undefined
  }
}

function unwrap<T>(value: T | { error: unknown }): T {
  if (typeof value === 'object' && value !== null && 'error' in value) {
    const err = (value as { error: { message?: string } | string }).error
    throw new Error(typeof err === 'string' ? err : (err?.message ?? 'The wallet refused the request'))
  }
  return value as T
}

/** Connects to the Nimiq provider. Resolves null outside Nimiq Pay. */
export async function connectNimiq(timeout = 2500): Promise<NimiqSession | null> {
  let provider: NimiqProvider
  try {
    provider = await init({ timeout })
  } catch {
    return null
  }
  const accounts = unwrap(await provider.listAccounts())
  return { provider, accounts }
}

/** Spendable NIM in Luna: the wallet address plus the HTLC address. */
export async function nimBalance(session: NimiqSession): Promise<bigint> {
  const values = await Promise.all(
    session.accounts.map(async (a) => BigInt(Math.trunc(unwrap(await session.provider.getBalance(a))))),
  )
  return values.reduce((sum, v) => sum + v, 0n)
}

/** The wallet's staker record, read from a public Nimiq node. */
export async function nimStaker(session: NimiqSession): Promise<Staker | null> {
  const wallet = session.accounts[0]
  return wallet ? fetchStaker(wallet).catch(() => null) : null
}

/**
 * Stakes `luna` with `validator`. A wallet that already stakes adds to its
 * stake; a new staker is created with the chosen validator.
 */
export async function stake(
  session: NimiqSession,
  validator: string,
  luna: bigint,
  existing: Staker | null,
): Promise<string> {
  const value = Number(luna)
  const hash = existing
    ? await session.provider.sendStakeTransaction({ value })
    : await session.provider.sendNewStakerTransaction({ delegation: validator, value })
  return unwrap(hash)
}
