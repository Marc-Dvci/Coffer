import type { Address, Hex } from 'viem'
import { keccak256, toBytes } from 'viem'
import type { Hook, TypedData } from './approval'
import { COW_SETTLEMENT, POLYGON_CHAIN_ID } from './tokens'

export const APP_CODE = 'Coffer'

/** Minutes an order stays open. Unfilled, it expires and nothing moves. */
export const ORDER_LIFETIME_MINUTES = 20

/** The order document: who built it and what must run before settlement. */
export function buildAppData(hooks: readonly Hook[]): { json: string; hash: Hex } {
  const doc: Record<string, unknown> = {
    appCode: APP_CODE,
    metadata: hooks.length > 0 ? { hooks: { pre: hooks, version: '0.1.0' } } : {},
    version: '1.3.0',
  }
  const json = JSON.stringify(doc)
  return { json, hash: keccak256(toBytes(json)) }
}

export interface Quote {
  sellToken: Address
  buyToken: Address
  /** Sold after the network fee, in sell-token units. */
  sellAmount: bigint
  /** Received for `sellAmount` at the quoted price, in buy-token units. */
  buyAmount: bigint
  /** Network fee, in sell-token units. */
  feeAmount: bigint
  id: number | null
}

export interface Order {
  sellToken: Address
  buyToken: Address
  receiver: Address
  sellAmount: bigint
  buyAmount: bigint
  validTo: number
  appData: Hex
  feeAmount: bigint
  kind: 'sell'
  partiallyFillable: false
  sellTokenBalance: 'erc20'
  buyTokenBalance: 'erc20'
}

/** Lowest amount received that the order accepts, after `slippageBps`. */
export function minimumReceived(buyAmount: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error('Slippage must be a whole number of basis points below 10000')
  }
  return (buyAmount * BigInt(10_000 - slippageBps)) / 10_000n
}

export interface OrderInput {
  quote: Quote
  owner: Address
  slippageBps: number
  appDataHash: Hex
  /** Unix seconds now. */
  now: number
}

/**
 * A fill-or-expire sell order. The owner sells `sellAmount + feeAmount` (the
 * amount typed in), receives at least the quoted amount less slippage, and is
 * the only receiver. The fee is taken from the sold amount by the settlement.
 */
export function buildOrder(input: OrderInput): Order {
  const { quote } = input
  if (quote.sellAmount <= 0n || quote.buyAmount <= 0n) throw new Error('Empty quote')
  return {
    sellToken: quote.sellToken,
    buyToken: quote.buyToken,
    receiver: input.owner,
    sellAmount: quote.sellAmount + quote.feeAmount,
    buyAmount: minimumReceived(quote.buyAmount, input.slippageBps),
    validTo: input.now + ORDER_LIFETIME_MINUTES * 60,
    appData: input.appDataHash,
    feeAmount: 0n,
    kind: 'sell',
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
  }
}

const ORDER_FIELDS = [
  { name: 'sellToken', type: 'address' },
  { name: 'buyToken', type: 'address' },
  { name: 'receiver', type: 'address' },
  { name: 'sellAmount', type: 'uint256' },
  { name: 'buyAmount', type: 'uint256' },
  { name: 'validTo', type: 'uint32' },
  { name: 'appData', type: 'bytes32' },
  { name: 'feeAmount', type: 'uint256' },
  { name: 'kind', type: 'string' },
  { name: 'partiallyFillable', type: 'bool' },
  { name: 'sellTokenBalance', type: 'string' },
  { name: 'buyTokenBalance', type: 'string' },
] as const

const ORDER_DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const

/** The order as the message the owner signs. */
export function buildOrderTypedData(order: Order): TypedData {
  return {
    types: { EIP712Domain: ORDER_DOMAIN_FIELDS, Order: ORDER_FIELDS },
    primaryType: 'Order',
    domain: {
      name: 'Gnosis Protocol',
      version: 'v2',
      chainId: POLYGON_CHAIN_ID,
      verifyingContract: COW_SETTLEMENT,
    },
    message: {
      ...order,
      sellAmount: order.sellAmount.toString(),
      buyAmount: order.buyAmount.toString(),
      feeAmount: order.feeAmount.toString(),
    },
  }
}
