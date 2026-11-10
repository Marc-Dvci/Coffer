import { describe, expect, it } from 'vitest'
import {
  concat,
  encodeAbiParameters,
  hashTypedData,
  type Hex,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
} from 'viem'
import type { Hook } from '../../src/core/approval'
import {
  buildAppData,
  buildOrder,
  buildOrderTypedData,
  minimumReceived,
  type Order,
  type Quote,
} from '../../src/core/order'
import { COW_SETTLEMENT, GOLD, USDT } from '../../src/core/tokens'
import { owner, signForTest, toTypedInput } from './helpers'

const NOW = 1_800_000_000
const APP_DATA_HASH = buildAppData([]).hash
const HOOK: Hook = { target: USDT.address, callData: '0x095ea7b3', gasLimit: '120000' }

const QUOTE: Quote = {
  sellToken: USDT.address,
  buyToken: GOLD.address,
  sellAmount: 990_000n,
  buyAmount: 2_475_000_000_000_000_000n,
  feeAmount: 10_000n,
  id: 42,
}

function makeOrder(overrides: Partial<Parameters<typeof buildOrder>[0]> = {}): Order {
  return buildOrder({
    quote: QUOTE,
    owner,
    slippageBps: 50,
    appDataHash: APP_DATA_HASH,
    now: NOW,
    ...overrides,
  })
}

const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
const ORDER_TYPE =
  'Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,string kind,bool partiallyFillable,string sellTokenBalance,string buyTokenBalance)'

/** GPv2 order digest, built from the EIP-712 rules without viem's typed-data encoder. */
function gpv2Digest(order: Order): Hex {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        keccak256(toBytes(DOMAIN_TYPE)),
        keccak256(toBytes('Gnosis Protocol')),
        keccak256(toBytes('v2')),
        137n,
        COW_SETTLEMENT,
      ],
    ),
  )
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bool' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        keccak256(toBytes(ORDER_TYPE)),
        order.sellToken,
        order.buyToken,
        order.receiver,
        order.sellAmount,
        order.buyAmount,
        order.validTo,
        order.appData,
        order.feeAmount,
        keccak256(toBytes(order.kind)),
        order.partiallyFillable,
        keccak256(toBytes(order.sellTokenBalance)),
        keccak256(toBytes(order.buyTokenBalance)),
      ],
    ),
  )
  return keccak256(concat(['0x1901', domainSeparator, structHash]))
}

describe('buildAppData', () => {
  it('hashes the order document as keccak256 of its UTF-8 bytes', () => {
    const { json, hash } = buildAppData([HOOK])
    expect(hash).toBe(keccak256(new TextEncoder().encode(json)))
  })

  it('writes a JSON document that names the Coffer app code', () => {
    expect(JSON.parse(buildAppData([]).json)).toMatchObject({ appCode: 'Coffer' })
  })

  it('carries the pre-settlement hooks under metadata.hooks.pre', () => {
    const doc = JSON.parse(buildAppData([HOOK]).json)
    expect(doc.metadata.hooks.pre).toEqual([HOOK])
  })

  it('leaves out the hooks key when there are no hooks', () => {
    const doc = JSON.parse(buildAppData([]).json)
    expect(doc.metadata).not.toHaveProperty('hooks')
  })
})

describe('minimumReceived', () => {
  it.each([
    { buyAmount: 1_000_000n, bps: 0, expected: 1_000_000n },
    { buyAmount: 1_000_000n, bps: 50, expected: 995_000n },
    { buyAmount: 101n, bps: 50, expected: 100n },
    { buyAmount: 1_000_000n, bps: 9_999, expected: 100n },
  ])('keeps $expected of $buyAmount after $bps bps of slippage, rounding down', ({ buyAmount, bps, expected }) => {
    expect(minimumReceived(buyAmount, bps)).toBe(expected)
  })

  it.each([-1, 0.5, 10_000, 10_001])('refuses slippage of %s basis points', (bps) => {
    expect(() => minimumReceived(1_000_000n, bps)).toThrow(
      'Slippage must be a whole number of basis points below 10000',
    )
  })
})

describe('buildOrder', () => {
  it('sells the amount typed in, which is the net sell amount plus the network fee', () => {
    expect(makeOrder().sellAmount).toBe(1_000_000n)
  })

  it('leaves the fee at zero in the signed order', () => {
    expect(makeOrder().feeAmount).toBe(0n)
  })

  it('names the owner as the only receiver', () => {
    expect(makeOrder().receiver).toBe(owner)
  })

  it('expires twenty minutes after the given time', () => {
    expect(makeOrder().validTo).toBe(NOW + 20 * 60)
  })

  it('asks for the quoted buy amount less the slippage', () => {
    expect(makeOrder().buyAmount).toBe(2_462_625_000_000_000_000n)
  })

  it('is a sell order that is never partially fillable and uses erc20 balances', () => {
    expect(makeOrder()).toMatchObject({
      kind: 'sell',
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    })
  })

  it('carries the app data hash it was given', () => {
    expect(makeOrder().appData).toBe(APP_DATA_HASH)
  })

  it.each([
    { sellAmount: 0n, buyAmount: 5n },
    { sellAmount: 5n, buyAmount: 0n },
  ])('refuses an empty quote (sell $sellAmount, buy $buyAmount)', ({ sellAmount, buyAmount }) => {
    expect(() =>
      buildOrder({
        quote: { ...QUOTE, sellAmount, buyAmount },
        owner,
        slippageBps: 50,
        appDataHash: APP_DATA_HASH,
        now: NOW,
      }),
    ).toThrow('Empty quote')
  })
})

describe('buildOrderTypedData', () => {
  it('hashes to the digest of the GPv2 order struct computed by hand', () => {
    const order = makeOrder()
    expect(hashTypedData(toTypedInput(buildOrderTypedData(order)))).toBe(gpv2Digest(order))
  })

  it('signs so that the signature recovers the owner', async () => {
    const data = buildOrderTypedData(makeOrder())
    const signature = await signForTest(data)
    expect(await recoverTypedDataAddress({ ...toTypedInput(data), signature })).toBe(owner)
  })
})
