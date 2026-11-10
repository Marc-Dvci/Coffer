import { describe, expect, it } from 'vitest'
import {
  decodeFunctionData,
  type Hex,
  maxUint256,
  parseSignature,
  recoverTypedDataAddress,
} from 'viem'
import {
  APPROVAL_ABI,
  type ApprovalRequest,
  approveCallData,
  buildApprovalHook,
  buildApprovalTypedData,
  nonceFunction,
} from '../../src/core/approval'
import { COW_VAULT_RELAYER, BITCOIN, EURO, GOLD, type Token, USDT } from '../../src/core/tokens'
import { owner, signForTest, toTypedInput } from './helpers'

const DEADLINE = 1_900_000_000n
const NONCE = 7n
const ONE_USDT = 1_000_000n
const TWO_AND_HALF_PAXG = 2_500_000_000_000_000_000n

function request(token: Token, amount: bigint): ApprovalRequest {
  return { token, owner, amount, nonce: NONCE, deadline: DEADLINE }
}

function wholeUnit(token: Token): bigint {
  return 10n ** BigInt(token.decimals)
}

describe('buildApprovalTypedData', () => {
  it('asks a permit token to let the vault relayer pull exactly the amount, with the nonce and deadline', () => {
    const data = buildApprovalTypedData(request(USDT, ONE_USDT))
    expect(data.primaryType).toBe('Permit')
    expect(data.message).toEqual({
      owner,
      spender: COW_VAULT_RELAYER,
      value: '1000000',
      nonce: '7',
      deadline: '1900000000',
    })
  })

  it('asks a meta-transaction token to sign the function call approve(vault relayer, amount)', () => {
    const data = buildApprovalTypedData(request(GOLD, TWO_AND_HALF_PAXG))
    expect(data.primaryType).toBe('MetaTransaction')
    expect(data.message).toMatchObject({ nonce: '7', from: owner })
    expect(decodeFunctionData({ abi: APPROVAL_ABI, data: data.message.functionSignature as Hex })).toEqual({
      functionName: 'approve',
      args: [COW_VAULT_RELAYER, TWO_AND_HALF_PAXG],
    })
  })

  it.each([USDT, EURO, GOLD, BITCOIN])('the $symbol approval signs with the test key and recovers to the owner', async (token) => {
    const data = buildApprovalTypedData(request(token, wholeUnit(token)))
    const signature = await signForTest(data)
    const signer = await recoverTypedDataAddress({ ...toTypedInput(data), signature })
    expect(signer).toBe(owner)
  })

  it('binds the signature to the amount, so a signature for one amount does not authorise another', async () => {
    const signature = await signForTest(buildApprovalTypedData(request(USDT, ONE_USDT)))
    const other = buildApprovalTypedData(request(USDT, 2n * ONE_USDT))
    const signer = await recoverTypedDataAddress({ ...toTypedInput(other), signature })
    expect(signer).not.toBe(owner)
  })

  it.each([0n, -1n])('refuses to build an approval for %s units', (amount) => {
    expect(() => buildApprovalTypedData(request(USDT, amount))).toThrow('Approval amount must be positive')
  })
})

describe('buildApprovalHook', () => {
  it('builds a permit call that the token accepts with the owner signature, for exactly the amount', async () => {
    const req = request(USDT, ONE_USDT)
    const signature = await signForTest(buildApprovalTypedData(req))
    const { r, s, v } = parseSignature(signature)
    const hook = buildApprovalHook(req, signature)
    const decoded = decodeFunctionData({ abi: APPROVAL_ABI, data: hook.callData })

    expect(hook.target).toBe(USDT.address)
    expect(decoded.functionName).toBe('permit')
    expect(decoded.args).toEqual([owner, COW_VAULT_RELAYER, ONE_USDT, DEADLINE, Number(v), r, s])
    expect([27, 28]).toContain(Number(v))
  })

  it('builds an executeMetaTransaction call that wraps approve(vault relayer, amount) for a meta-transaction token', async () => {
    const req = request(GOLD, TWO_AND_HALF_PAXG)
    const signature = await signForTest(buildApprovalTypedData(req))
    const { r, s, v } = parseSignature(signature)
    const hook = buildApprovalHook(req, signature)
    const decoded = decodeFunctionData({ abi: APPROVAL_ABI, data: hook.callData })

    expect(hook.target).toBe(GOLD.address)
    expect(decoded.functionName).toBe('executeMetaTransaction')
    expect(decoded.args).toEqual([owner, approveCallData(TWO_AND_HALF_PAXG), r, s, Number(v)])
    expect(decodeFunctionData({ abi: APPROVAL_ABI, data: approveCallData(TWO_AND_HALF_PAXG) })).toEqual({
      functionName: 'approve',
      args: [COW_VAULT_RELAYER, TWO_AND_HALF_PAXG],
    })
  })

  it('approves the exact amount, never the unlimited allowance', () => {
    const decoded = decodeFunctionData({ abi: APPROVAL_ABI, data: approveCallData(ONE_USDT) })
    expect(decoded.args?.[1]).toBe(ONE_USDT)
    expect(decoded.args?.[1]).not.toBe(maxUint256)
  })
})

describe('nonceFunction', () => {
  it.each([
    { symbol: 'USDT', token: USDT, view: 'nonces' },
    { symbol: 'PAXG', token: GOLD, view: 'getNonce' },
  ])('reads the nonce of the $symbol through $view', ({ token, view }) => {
    expect(nonceFunction(token)).toBe(view)
  })
})
