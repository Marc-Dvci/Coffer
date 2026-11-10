import type { Address, Hex } from 'viem'
import { pad, toHex } from 'viem'

export const POLYGON_CHAIN_ID = 137

/** CoW Protocol contracts, identical on every chain it serves. */
export const COW_SETTLEMENT: Address = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
export const COW_VAULT_RELAYER: Address = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'

/** How a token accepts an approval signed off chain. */
export type ApprovalKind = 'permit' | 'metaTransaction'

/** The EIP-712 domain layout the token contract hashes. */
export type DomainKind = 'chainId' | 'salt'

export type HoldingId = 'usdt' | 'gold' | 'euro' | 'bitcoin'

export interface Token {
  id: HoldingId
  /** Name shown on the statement. */
  label: string
  symbol: string
  issuer: string
  /** One line saying what one unit is. */
  unit: string
  address: Address
  decimals: number
  /** Decimals shown for a balance. */
  display: number
  approval: ApprovalKind
  domain: DomainKind
  /** `name` field of the token's EIP-712 domain. */
  domainName: string
  /** CoinGecko id used for the reference price. */
  priceId: string
}

export const USDT: Token = {
  id: 'usdt',
  label: 'Dollars',
  symbol: 'USDT',
  issuer: 'Tether',
  unit: '1 USDT is redeemable by Tether for one US dollar.',
  address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  decimals: 6,
  display: 2,
  approval: 'permit',
  domain: 'salt',
  domainName: 'USDT0',
  priceId: 'tether',
}

export const GOLD: Token = {
  id: 'gold',
  label: 'Gold',
  symbol: 'PAXG',
  issuer: 'Paxos',
  unit: '1 PAXG is one fine troy ounce of gold held in London vaults by Paxos.',
  address: '0x553d3D295e0f695B9228246232eDF400ed3560B5',
  decimals: 18,
  display: 5,
  approval: 'metaTransaction',
  domain: 'salt',
  domainName: 'Paxos Gold (PoS)',
  priceId: 'pax-gold',
}

export const EURO: Token = {
  id: 'euro',
  label: 'Euros',
  symbol: 'EURe',
  issuer: 'Monerium',
  unit: '1 EURe is one euro of e-money issued by Monerium.',
  address: '0xE0aEa583266584DafBB3f9C3211d5588c73fEa8d',
  decimals: 18,
  display: 2,
  approval: 'permit',
  domain: 'chainId',
  domainName: 'Monerium EURe',
  priceId: 'monerium-eur-money',
}

export const BITCOIN: Token = {
  id: 'bitcoin',
  label: 'Bitcoin',
  symbol: 'WBTC',
  issuer: 'BitGo',
  unit: '1 WBTC is one bitcoin held in custody by BitGo.',
  address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
  decimals: 8,
  display: 6,
  approval: 'metaTransaction',
  domain: 'salt',
  domainName: '(PoS) Wrapped BTC',
  priceId: 'wrapped-bitcoin',
}

/** Holdings a user can move savings into. USDT is the funding side. */
export const SAVINGS: readonly Token[] = [GOLD, EURO, BITCOIN]
export const ALL_TOKENS: readonly Token[] = [USDT, GOLD, EURO, BITCOIN]

export function tokenById(id: HoldingId): Token {
  const t = ALL_TOKENS.find((x) => x.id === id)
  if (!t) throw new Error(`Unknown holding: ${id}`)
  return t
}

const DOMAIN_FIELDS = {
  chainId: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  salt: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'verifyingContract', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ],
} as const

export interface TokenDomain {
  domain: {
    name: string
    version: string
    verifyingContract: Address
    chainId?: number
    salt?: Hex
  }
  fields: readonly { name: string; type: string }[]
}

/**
 * The EIP-712 domain each token contract uses. Tokens bridged through the
 * Polygon PoS bridge put the chain id in `salt`; EURe uses `chainId`.
 */
export function tokenDomain(token: Token): TokenDomain {
  if (token.domain === 'chainId') {
    return {
      domain: {
        name: token.domainName,
        version: '1',
        chainId: POLYGON_CHAIN_ID,
        verifyingContract: token.address,
      },
      fields: DOMAIN_FIELDS.chainId,
    }
  }
  return {
    domain: {
      name: token.domainName,
      version: '1',
      verifyingContract: token.address,
      salt: pad(toHex(POLYGON_CHAIN_ID), { size: 32 }),
    },
    fields: DOMAIN_FIELDS.salt,
  }
}
