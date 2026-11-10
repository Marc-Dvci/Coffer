import type { Address, Hex } from 'viem'
import type { Order, Quote } from './order'

export const COW_API = 'https://api.cow.fi/polygon/api/v1'
export const COW_EXPLORER = 'https://explorer.cow.fi/pol/orders/'

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export class CowError extends Error {
  constructor(
    readonly errorType: string,
    message: string,
  ) {
    super(message)
    this.name = 'CowError'
  }
}

async function readError(res: Response): Promise<CowError> {
  const text = await res.text()
  try {
    const body = JSON.parse(text) as { errorType?: string; description?: string }
    return new CowError(body.errorType ?? `Http${res.status}`, body.description ?? text)
  } catch {
    return new CowError(`Http${res.status}`, text || res.statusText)
  }
}

export interface QuoteRequest {
  sellToken: Address
  buyToken: Address
  owner: Address
  /** Amount sold including the fee, in sell-token units. */
  amount: bigint
  appData: { json: string; hash: Hex }
}

/** Asks the CoW order book what `amount` of the sell token buys right now. */
export async function fetchQuote(req: QuoteRequest, fetchFn: Fetch = fetch): Promise<Quote> {
  const res = await fetchFn(`${COW_API}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sellToken: req.sellToken,
      buyToken: req.buyToken,
      from: req.owner,
      receiver: req.owner,
      sellAmountBeforeFee: req.amount.toString(),
      kind: 'sell',
      signingScheme: 'eip712',
      onchainOrder: false,
      appData: req.appData.json,
      appDataHash: req.appData.hash,
    }),
  })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as {
    quote: { sellAmount: string; buyAmount: string; feeAmount: string }
    id?: number | null
  }
  return {
    sellToken: req.sellToken,
    buyToken: req.buyToken,
    sellAmount: BigInt(body.quote.sellAmount),
    buyAmount: BigInt(body.quote.buyAmount),
    feeAmount: BigInt(body.quote.feeAmount),
    id: body.id ?? null,
  }
}

export interface OrderSubmission {
  order: Order
  owner: Address
  signature: Hex
  appDataJson: string
  quoteId: number | null
}

/** Places a signed order. Returns its unique id. */
export async function submitOrder(sub: OrderSubmission, fetchFn: Fetch = fetch): Promise<string> {
  const { order } = sub
  const res = await fetchFn(`${COW_API}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sellToken: order.sellToken,
      buyToken: order.buyToken,
      receiver: order.receiver,
      sellAmount: order.sellAmount.toString(),
      buyAmount: order.buyAmount.toString(),
      validTo: order.validTo,
      appData: sub.appDataJson,
      appDataHash: order.appData,
      feeAmount: '0',
      kind: order.kind,
      partiallyFillable: order.partiallyFillable,
      sellTokenBalance: order.sellTokenBalance,
      buyTokenBalance: order.buyTokenBalance,
      signingScheme: 'eip712',
      signature: sub.signature,
      from: sub.owner,
      quoteId: sub.quoteId,
    }),
  })
  if (!res.ok) throw await readError(res)
  return (await res.json()) as string
}

export type OrderState = 'open' | 'fulfilled' | 'expired' | 'cancelled'

export interface OrderStatus {
  uid: string
  state: OrderState
  sellToken: Address
  buyToken: Address
  executedSellAmount: bigint
  executedBuyAmount: bigint
  /** Fee the solver took, in sell-token units. */
  executedFee: bigint
  createdAt: string
  appCode: string | null
}

interface RawOrder {
  uid: string
  status: string
  sellToken: Address
  buyToken: Address
  executedSellAmount?: string
  executedBuyAmount?: string
  executedFee?: string
  executedFeeAmount?: string
  creationDate: string
  fullAppData?: string | null
}

function parseState(status: string): OrderState {
  if (status === 'fulfilled' || status === 'expired' || status === 'cancelled') return status
  return 'open'
}

function parseAppCode(fullAppData: string | null | undefined): string | null {
  if (!fullAppData) return null
  try {
    const doc = JSON.parse(fullAppData) as { appCode?: unknown }
    return typeof doc.appCode === 'string' ? doc.appCode : null
  } catch {
    return null
  }
}

function parseOrder(raw: RawOrder): OrderStatus {
  return {
    uid: raw.uid,
    state: parseState(raw.status),
    sellToken: raw.sellToken,
    buyToken: raw.buyToken,
    executedSellAmount: BigInt(raw.executedSellAmount ?? '0'),
    executedBuyAmount: BigInt(raw.executedBuyAmount ?? '0'),
    executedFee: BigInt(raw.executedFee ?? raw.executedFeeAmount ?? '0'),
    createdAt: raw.creationDate,
    appCode: parseAppCode(raw.fullAppData),
  }
}

export async function fetchOrder(uid: string, fetchFn: Fetch = fetch): Promise<OrderStatus> {
  const res = await fetchFn(`${COW_API}/orders/${uid}`)
  if (!res.ok) throw await readError(res)
  return parseOrder((await res.json()) as RawOrder)
}

/** The owner's most recent orders, newest first. */
export async function fetchOrders(
  owner: Address,
  limit = 50,
  fetchFn: Fetch = fetch,
): Promise<OrderStatus[]> {
  const res = await fetchFn(`${COW_API}/account/${owner}/orders?limit=${limit}`)
  if (!res.ok) throw await readError(res)
  return ((await res.json()) as RawOrder[]).map(parseOrder)
}

/** Settlement transaction hashes for an order. Empty until it is filled. */
export async function fetchTradeHashes(uid: string, fetchFn: Fetch = fetch): Promise<Hex[]> {
  const res = await fetchFn(`${COW_API}/trades?orderUid=${uid}`)
  if (!res.ok) throw await readError(res)
  const trades = (await res.json()) as { txHash?: Hex | null }[]
  return trades.map((t) => t.txHash).filter((h): h is Hex => typeof h === 'string')
}
