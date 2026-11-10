import type { Address, Hex } from 'viem'
import {
  type ApprovalRequest,
  buildApprovalHook,
  buildApprovalTypedData,
  type Hook,
  type TypedData,
} from './approval'
import { CowError, type OrderStatus } from './cow'
import { checkMove, LIMITS, type Refusal } from './guard'
import { buildAppData, buildOrder, buildOrderTypedData, type Quote } from './order'
import type { Token } from './tokens'

/** Everything a move needs from the outside world. */
export interface MoveDeps {
  now: () => number
  balanceOf: (token: Token, owner: Address) => Promise<bigint>
  allowance: (token: Token, owner: Address) => Promise<bigint>
  nonce: (token: Token, owner: Address) => Promise<bigint>
  signTypedData: (owner: Address, data: TypedData) => Promise<Hex>
  quote: (req: {
    sellToken: Address
    buyToken: Address
    owner: Address
    amount: bigint
    appData: { json: string; hash: Hex }
  }) => Promise<Quote>
  submit: (sub: {
    order: ReturnType<typeof buildOrder>
    owner: Address
    signature: Hex
    appDataJson: string
    quoteId: number | null
  }) => Promise<string>
  order: (uid: string) => Promise<OrderStatus>
  tradeHashes: (uid: string) => Promise<Hex[]>
  /** Reference prices in US dollars per whole token. */
  priceUsd: (token: Token) => number | undefined
  wait: (ms: number) => Promise<void>
}

export type MoveStep =
  | { step: 'approval-signature' }
  | { step: 'quote'; quote: Quote }
  | { step: 'order-signature' }
  | { step: 'placed'; uid: string }
  | { step: 'settling'; uid: string }

export type MoveResult =
  | { outcome: 'refused'; refusal: Refusal }
  | { outcome: 'declined'; at: 'approval-signature' | 'order-signature' }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'expired'; uid: string }
  | {
      outcome: 'settled'
      uid: string
      txHash: Hex | null
      sold: bigint
      received: bigint
      fee: bigint
      /** Balance of the bought token read from the chain after settlement. */
      balanceAfter: bigint
      balanceBefore: bigint
    }

export interface MoveRequest {
  owner: Address
  sell: Token
  buy: Token
  /** Amount sold, fee included, in sell-token units. */
  amount: bigint
}

/** Seconds a signed approval stays usable. */
export const APPROVAL_LIFETIME_SECONDS = 3600
const POLL_MS = 4000

function isUserRejection(err: unknown): boolean {
  const e = err as { code?: number; message?: string }
  return e?.code === 4001 || /reject|denied|cancel/i.test(e?.message ?? '')
}

/** A quote for a move that carries no approval, for showing a price before signing. */
export async function previewQuote(deps: MoveDeps, req: MoveRequest): Promise<Quote> {
  return deps.quote({
    sellToken: req.sell.address,
    buyToken: req.buy.address,
    owner: req.owner,
    amount: req.amount,
    appData: buildAppData([]),
  })
}

/**
 * Runs one move from start to receipt.
 *
 * 1. If the settlement contract may not yet pull `amount`, the owner signs an
 *    approval for exactly that amount. It travels inside the order.
 * 2. The order book quotes the move; the quote must pass every limit.
 * 3. The owner signs the order. A solver settles it and pays the gas.
 * 4. The result is read back from the order book and from the chain.
 */
export async function runMove(
  deps: MoveDeps,
  req: MoveRequest,
  onStep: (s: MoveStep) => void = () => {},
): Promise<MoveResult> {
  const { owner, sell, buy, amount } = req
  const [balance, allowance, balanceBefore] = await Promise.all([
    deps.balanceOf(sell, owner),
    deps.allowance(sell, owner),
    deps.balanceOf(buy, owner),
  ])
  if (amount > balance) return { outcome: 'refused', refusal: { code: 'exceeds-balance' } }

  const hooks: Hook[] = []
  if (allowance < amount) {
    const approval: ApprovalRequest = {
      token: sell,
      owner,
      amount,
      nonce: await deps.nonce(sell, owner),
      deadline: BigInt(deps.now() + APPROVAL_LIFETIME_SECONDS),
    }
    onStep({ step: 'approval-signature' })
    let signature: Hex
    try {
      signature = await deps.signTypedData(owner, buildApprovalTypedData(approval))
    } catch (err) {
      if (isUserRejection(err)) return { outcome: 'declined', at: 'approval-signature' }
      throw err
    }
    hooks.push(buildApprovalHook(approval, signature))
  }

  const appData = buildAppData(hooks)
  let quote: Quote
  try {
    quote = await deps.quote({
      sellToken: sell.address,
      buyToken: buy.address,
      owner,
      amount,
      appData,
    })
  } catch (err) {
    if (err instanceof CowError) return { outcome: 'rejected', reason: err.message }
    throw err
  }
  onStep({ step: 'quote', quote })

  const refusal = checkMove({
    quote,
    balance,
    sellDecimals: sell.decimals,
    buyDecimals: buy.decimals,
    sellPriceUsd: deps.priceUsd(sell),
    buyPriceUsd: deps.priceUsd(buy),
  })
  if (refusal) return { outcome: 'refused', refusal }

  const order = buildOrder({
    quote,
    owner,
    slippageBps: LIMITS.slippageBps,
    appDataHash: appData.hash,
    now: deps.now(),
  })
  onStep({ step: 'order-signature' })
  let signature: Hex
  try {
    signature = await deps.signTypedData(owner, buildOrderTypedData(order))
  } catch (err) {
    if (isUserRejection(err)) return { outcome: 'declined', at: 'order-signature' }
    throw err
  }

  let uid: string
  try {
    uid = await deps.submit({ order, owner, signature, appDataJson: appData.json, quoteId: quote.id })
  } catch (err) {
    if (err instanceof CowError) return { outcome: 'rejected', reason: err.message }
    throw err
  }
  onStep({ step: 'placed', uid })

  for (;;) {
    onStep({ step: 'settling', uid })
    let status: OrderStatus | null = null
    try {
      status = await deps.order(uid)
    } catch (err) {
      if (!(err instanceof CowError)) throw err
    }
    if (status?.state === 'fulfilled') {
      const [hashes, balanceAfter] = await Promise.all([
        deps.tradeHashes(uid).catch(() => [] as Hex[]),
        deps.balanceOf(buy, owner),
      ])
      return {
        outcome: 'settled',
        uid,
        txHash: hashes[0] ?? null,
        sold: status.executedSellAmount,
        received: status.executedBuyAmount,
        fee: status.executedFee,
        balanceBefore,
        balanceAfter,
      }
    }
    if (status?.state === 'expired' || status?.state === 'cancelled') {
      return { outcome: 'expired', uid }
    }
    if (deps.now() > order.validTo + 60) return { outcome: 'expired', uid }
    await deps.wait(POLL_MS)
  }
}
