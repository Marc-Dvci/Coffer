import { describe, expect, it } from 'vitest'
import {
  fetchStaker,
  fetchValidators,
  MIN_STAKE_LUNA,
  NIMIQ_RPC,
  parseStaker,
  parseValidators,
  rankValidators,
  type Validator,
  VALIDATORS_API,
} from '../../src/core/staking'
import { at, fakeFetch, json } from './helpers'

function pool(name: string, overrides: Partial<Validator> = {}): Validator {
  return { address: `NQ00 ${name.toUpperCase()}`, name, fee: 0.05, score: 0.99, payout: 'restake', ...overrides }
}

function rawPool(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: `NQ00 ${name.toUpperCase()}`,
    name,
    fee: 0.05,
    payoutType: 'restake',
    score: { total: 0.99 },
    ...overrides,
  }
}

/** A staker answer in the shape the public node returned on 10 November 2026. */
const STAKER_BODY = {
  jsonrpc: '2.0',
  result: {
    data: {
      address: 'NQ38 TS66 VY57 5UX0 4A8J 6VTE RJU8 1ATD AVVJ',
      balance: 10_000_000,
      delegation: 'NQ15 HNAH YRVH DFVM YHAG BSXG 0QHK KA0Q XDR7',
      inactiveBalance: 0,
      inactiveFrom: null,
      retiredBalance: 0,
    },
    metadata: { blockNumber: 66_516_727 },
  },
  id: 1,
}

const NO_STAKER_BODY = {
  jsonrpc: '2.0',
  error: { code: -32603, message: 'Internal error', data: 'No staker with address: NQ51 SURF' },
  id: 1,
}

describe('MIN_STAKE_LUNA', () => {
  it('is 100 NIM', () => {
    expect(MIN_STAKE_LUNA).toBe(100n * 100_000n)
  })
})

describe('rankValidators', () => {
  it('puts the highest trust score first', () => {
    const ranked = rankValidators([pool('b', { score: 0.95 }), pool('a', { score: 0.999 })])
    expect(ranked.map((v) => v.name)).toEqual(['a', 'b'])
  })

  it('breaks a score tie with the lower fee', () => {
    const ranked = rankValidators([pool('dear', { fee: 0.1 }), pool('cheap', { fee: 0.01 })])
    expect(ranked.map((v) => v.name)).toEqual(['cheap', 'dear'])
  })

  it('treats scores within a thousandth as a tie', () => {
    const ranked = rankValidators([pool('dear', { score: 0.9999, fee: 0.1 }), pool('cheap', { score: 0.9996, fee: 0 })])
    expect(ranked.map((v) => v.name)).toEqual(['cheap', 'dear'])
  })

  it('breaks a full tie by name', () => {
    expect(rankValidators([pool('zeta'), pool('alpha')]).map((v) => v.name)).toEqual(['alpha', 'zeta'])
  })

  it('leaves out pools that pay no rewards to the staker', () => {
    expect(rankValidators([pool('solo', { payout: 'none' }), pool('pays')]).map((v) => v.name)).toEqual(['pays'])
  })

  it('keeps a pool at a score of 0.9 and leaves out one just below', () => {
    const ranked = rankValidators([pool('at', { score: 0.9 }), pool('below', { score: 0.8999 })])
    expect(ranked.map((v) => v.name)).toEqual(['at'])
  })

  it('returns a new list and leaves its input in place', () => {
    const input = [pool('b', { score: 0.95 }), pool('a', { score: 0.999 })]
    rankValidators(input)
    expect(input.map((v) => v.name)).toEqual(['b', 'a'])
  })
})

describe('parseValidators', () => {
  it('reads name, address, fee, score and payout of each pool', () => {
    expect(parseValidators([rawPool('Harbour', { fee: 0.02, payoutType: 'direct', score: { total: 0.97 } })])).toEqual([
      { address: 'NQ00 HARBOUR', name: 'Harbour', fee: 0.02, score: 0.97, payout: 'direct' },
    ])
  })

  it.each([
    { name: 'no name', raw: rawPool('x', { name: '' }) },
    { name: 'no address', raw: rawPool('x', { address: undefined }) },
    { name: 'a fee given as text', raw: rawPool('x', { fee: '5%' }) },
    { name: 'no score', raw: rawPool('x', { score: null }) },
    { name: 'no payout type', raw: rawPool('x', { payoutType: undefined }) },
    { name: 'a null entry', raw: null },
  ])('leaves out a pool with $name', ({ raw }) => {
    expect(parseValidators([raw, rawPool('kept')]).map((v) => v.name)).toEqual(['kept'])
  })

  it.each([null, {}, 'error'])('reads %s as no pools', (body) => {
    expect(parseValidators(body)).toEqual([])
  })
})

describe('fetchValidators', () => {
  it('reads the ranked pools from the validators API', async () => {
    const { fetchFn, calls } = fakeFetch(() => json([rawPool('b', { score: { total: 0.95 } }), rawPool('a')]))
    expect((await fetchValidators(fetchFn)).map((v) => v.name)).toEqual(['a', 'b'])
    expect(at(calls, 0).url).toBe(VALIDATORS_API)
  })

  it('fails with the status when the API refuses', async () => {
    const { fetchFn } = fakeFetch(() => json({}, 503))
    await expect(fetchValidators(fetchFn)).rejects.toThrow('Validator list answered 503')
  })
})

describe('parseStaker', () => {
  it('reads the active stake and the pool of a staker', () => {
    expect(parseStaker(STAKER_BODY)).toEqual({
      balanceLuna: 10_000_000n,
      inactiveLuna: 0n,
      validator: 'NQ15 HNAH YRVH DFVM YHAG BSXG 0QHK KA0Q XDR7',
    })
  })

  it('adds inactive and retired stake together', () => {
    const body = { result: { data: { balance: 5, inactiveBalance: 300, retiredBalance: 40 } } }
    expect(parseStaker(body)).toEqual({ balanceLuna: 5n, inactiveLuna: 340n, validator: null })
  })

  it('reads the node answer for an address with no stake as no staker', () => {
    expect(parseStaker(NO_STAKER_BODY)).toBeNull()
  })

  it.each([null, undefined, {}, { result: {} }, { result: { data: 'x' } }])('reads %j as no staker', (body) => {
    expect(parseStaker(body)).toBeNull()
  })

  it('reads a missing, negative or text balance as zero', () => {
    const body = { result: { data: { balance: -1, inactiveBalance: '7' } } }
    expect(parseStaker(body)).toEqual({ balanceLuna: 0n, inactiveLuna: 0n, validator: null })
  })
})

describe('fetchStaker', () => {
  it('asks the public node for the staker by address', async () => {
    const { fetchFn, calls } = fakeFetch(() => json(STAKER_BODY))
    const staker = await fetchStaker('NQ38 TS66', fetchFn)
    expect(staker?.balanceLuna).toBe(10_000_000n)
    const call = at(calls, 0)
    expect(call.url).toBe(NIMIQ_RPC)
    expect(JSON.parse(String(call.init?.body))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'getStakerByAddress',
      params: ['NQ38 TS66'],
    })
  })

  it('fails with the status when the node refuses', async () => {
    const { fetchFn } = fakeFetch(() => json({}, 502))
    await expect(fetchStaker('NQ38 TS66', fetchFn)).rejects.toThrow('Nimiq RPC answered 502')
  })
})
