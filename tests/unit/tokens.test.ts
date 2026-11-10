import { describe, expect, it } from 'vitest'
import { hashDomain, isAddress } from 'viem'
import {
  ALL_TOKENS,
  BITCOIN,
  COW_SETTLEMENT,
  COW_VAULT_RELAYER,
  EURO,
  GOLD,
  type HoldingId,
  SAVINGS,
  USDT,
  tokenById,
  tokenDomain,
} from '../../src/core/tokens'

describe('tokenDomain', () => {
  it.each([
    {
      symbol: 'USDT',
      token: USDT,
      separator: '0x7b43b7deae87806d0ace67d6c8e9e347fc85db8ad198e756e5c17d126fef9a05',
    },
    {
      symbol: 'PAXG',
      token: GOLD,
      separator: '0xbad432510e418bfc45423ccda05ff4fbfe1fa3ca22d3cc60d55be31d5c8432a4',
    },
    {
      symbol: 'EURe',
      token: EURO,
      separator: '0x42efa2d0a3b73ff969a3183c7e0dc99192dff9f3d3194071935511dd9a635967',
    },
    {
      symbol: 'WBTC',
      token: BITCOIN,
      separator: '0x2363d9601e5ca2e04327ef03d7610d9eee2aeec7c19272c0e9db88c8361214fc',
    },
  ])('hashes the $symbol domain to the separator its contract reports on Polygon', ({ token, separator }) => {
    const { domain, fields } = tokenDomain(token)
    expect(hashDomain({ domain, types: { EIP712Domain: fields } } as Parameters<typeof hashDomain>[0])).toBe(separator)
  })

  it.each([USDT, GOLD, BITCOIN])('carries the Polygon chain id in the salt of the bridged $symbol', (token) => {
    const { domain, fields } = tokenDomain(token)
    expect(domain.salt).toBe(`0x${'0'.repeat(62)}89`)
    expect(domain).not.toHaveProperty('chainId')
    expect(fields.map((f) => f.name)).toEqual(['name', 'version', 'verifyingContract', 'salt'])
  })

  it('carries the Polygon chain id as a domain field for EURe, with no salt', () => {
    const { domain, fields } = tokenDomain(EURO)
    expect(domain.chainId).toBe(137)
    expect(domain).not.toHaveProperty('salt')
    expect(fields.map((f) => f.name)).toEqual(['name', 'version', 'chainId', 'verifyingContract'])
  })
})

describe('token addresses', () => {
  it.each(ALL_TOKENS)('$symbol has a checksummed contract address', (token) => {
    expect(isAddress(token.address, { strict: true })).toBe(true)
  })

  it.each([COW_SETTLEMENT, COW_VAULT_RELAYER])('CoW contract %s is a checksummed address', (address) => {
    expect(isAddress(address, { strict: true })).toBe(true)
  })
})

describe('token registry', () => {
  it('gives every token a different id', () => {
    const ids = ALL_TOKENS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(ALL_TOKENS)('looks up $symbol by its id', (token) => {
    expect(tokenById(token.id)).toBe(token)
  })

  it('throws on an id that is not a holding', () => {
    const unknownId = 'dai' as string
    expect(() => tokenById(unknownId as HoldingId)).toThrow('Unknown holding: dai')
  })

  it('lists gold, euro and bitcoin as the savings and leaves USDT out, since it funds them', () => {
    expect(SAVINGS.map((t) => t.id)).toEqual(['gold', 'euro', 'bitcoin'])
  })
})
