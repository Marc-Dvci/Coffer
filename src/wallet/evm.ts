import { type Address, createPublicClient, fallback, getAddress, type Hex, http } from 'viem'
import { polygon } from 'viem/chains'
import { APPROVAL_ABI, nonceFunction, type TypedData } from '../core/approval'
import { ALL_TOKENS, COW_VAULT_RELAYER, type HoldingId, type Token } from '../core/tokens'

export interface Eip1193 {
  request(args: { method: string; params?: unknown }): Promise<unknown>
}

declare global {
  interface Window {
    ethereum?: Eip1193
  }
}

export const POLYGON_HEX = '0x89'
export const POLYGONSCAN_TX = 'https://polygonscan.com/tx/'

/** Read-only access to Polygon through public endpoints, independent of the wallet. */
export const reader = createPublicClient({
  chain: polygon,
  batch: { multicall: true },
  transport: fallback([
    http('https://polygon-bor-rpc.publicnode.com'),
    http('https://polygon.drpc.org'),
    http('https://1rpc.io/matic'),
  ]),
})

export function evmProvider(): Eip1193 | undefined {
  return typeof window === 'undefined' ? undefined : window.ethereum
}

/** Asks the wallet for its account and puts it on Polygon. */
export async function connectEvm(provider: Eip1193): Promise<Address> {
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
  const first = accounts[0]
  if (!first) throw new Error('The wallet returned no account')
  const chainId = (await provider.request({ method: 'eth_chainId' })) as string
  if (chainId.toLowerCase() !== POLYGON_HEX) {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: POLYGON_HEX }],
    })
  }
  return getAddress(first)
}

export async function signTypedData(
  provider: Eip1193,
  owner: Address,
  data: TypedData,
): Promise<Hex> {
  return (await provider.request({
    method: 'eth_signTypedData_v4',
    params: [owner, JSON.stringify(data)],
  })) as Hex
}

export async function balanceOf(token: Token, owner: Address): Promise<bigint> {
  return reader.readContract({
    address: token.address,
    abi: APPROVAL_ABI,
    functionName: 'balanceOf',
    args: [owner],
  })
}

export async function allowance(token: Token, owner: Address): Promise<bigint> {
  return reader.readContract({
    address: token.address,
    abi: APPROVAL_ABI,
    functionName: 'allowance',
    args: [owner, COW_VAULT_RELAYER],
  })
}

export async function nonce(token: Token, owner: Address): Promise<bigint> {
  return reader.readContract({
    address: token.address,
    abi: APPROVAL_ABI,
    functionName: nonceFunction(token),
    args: [owner],
  })
}

/** Balances of every holding, in one batched read. */
export async function tokenBalances(owner: Address): Promise<Record<HoldingId, bigint>> {
  const values = await Promise.all(ALL_TOKENS.map((t) => balanceOf(t, owner)))
  return Object.fromEntries(ALL_TOKENS.map((t, i) => [t.id, values[i] ?? 0n])) as Record<
    HoldingId,
    bigint
  >
}
