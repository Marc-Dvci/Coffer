import type { Address, Hex } from 'viem'
import { encodeFunctionData, parseAbi, parseSignature } from 'viem'
import { COW_VAULT_RELAYER, type Token, tokenDomain } from './tokens'

export const APPROVAL_ABI = parseAbi([
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function executeMetaTransaction(address userAddress, bytes functionSignature, bytes32 sigR, bytes32 sigS, uint8 sigV) payable returns (bytes)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function nonces(address owner) view returns (uint256)',
  'function getNonce(address user) view returns (uint256)',
])

/** Typed data in the JSON shape `eth_signTypedData_v4` takes. */
export interface TypedData {
  types: Record<string, readonly { name: string; type: string }[]>
  primaryType: string
  domain: Record<string, unknown>
  message: Record<string, unknown>
}

export interface ApprovalRequest {
  token: Token
  owner: Address
  /** Exact amount the settlement contract may pull, in token units. */
  amount: bigint
  /** The owner's current nonce on the token contract. */
  nonce: bigint
  /** Unix seconds. Used by `permit`; a meta-transaction has no deadline. */
  deadline: bigint
}

/** A call anyone can submit that sets the allowance the owner signed. */
export interface Hook {
  target: Address
  callData: Hex
  gasLimit: string
}

const PERMIT_FIELDS = [
  { name: 'owner', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] as const

const META_TX_FIELDS = [
  { name: 'nonce', type: 'uint256' },
  { name: 'from', type: 'address' },
  { name: 'functionSignature', type: 'bytes' },
] as const

/** Calldata of `approve(vaultRelayer, amount)`, the call a meta-transaction wraps. */
export function approveCallData(amount: bigint): Hex {
  return encodeFunctionData({
    abi: APPROVAL_ABI,
    functionName: 'approve',
    args: [COW_VAULT_RELAYER, amount],
  })
}

/**
 * The message the owner signs to let the CoW vault relayer pull exactly
 * `amount` of `token`. No transaction and no gas: the signature is carried
 * by the order and submitted by the solver that settles it.
 */
export function buildApprovalTypedData(req: ApprovalRequest): TypedData {
  if (req.amount <= 0n) throw new Error('Approval amount must be positive')
  const { domain, fields } = tokenDomain(req.token)
  if (req.token.approval === 'permit') {
    return {
      types: { EIP712Domain: fields, Permit: PERMIT_FIELDS },
      primaryType: 'Permit',
      domain,
      message: {
        owner: req.owner,
        spender: COW_VAULT_RELAYER,
        value: req.amount.toString(),
        nonce: req.nonce.toString(),
        deadline: req.deadline.toString(),
      },
    }
  }
  return {
    types: { EIP712Domain: fields, MetaTransaction: META_TX_FIELDS },
    primaryType: 'MetaTransaction',
    domain,
    message: {
      nonce: req.nonce.toString(),
      from: req.owner,
      functionSignature: approveCallData(req.amount),
    },
  }
}

/** Gas a solver reserves for the approval call. Measured use is under 80,000. */
export const HOOK_GAS_LIMIT = '120000'

/** Turns the owner's signature into the pre-settlement call. */
export function buildApprovalHook(req: ApprovalRequest, signature: Hex): Hook {
  const { r, s, v, yParity } = parseSignature(signature)
  const sigV = Number(v ?? BigInt(27 + yParity))
  const callData =
    req.token.approval === 'permit'
      ? encodeFunctionData({
          abi: APPROVAL_ABI,
          functionName: 'permit',
          args: [req.owner, COW_VAULT_RELAYER, req.amount, req.deadline, sigV, r, s],
        })
      : encodeFunctionData({
          abi: APPROVAL_ABI,
          functionName: 'executeMetaTransaction',
          args: [req.owner, approveCallData(req.amount), r, s, sigV],
        })
  return { target: req.token.address, callData, gasLimit: HOOK_GAS_LIMIT }
}

/** Name of the view that returns the owner's nonce for this token's scheme. */
export function nonceFunction(token: Token): 'nonces' | 'getNonce' {
  return token.approval === 'permit' ? 'nonces' : 'getNonce'
}
