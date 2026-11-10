# Coffer inside Nimiq Pay: wallet check

Run on 10 November 2026 with Nimiq Pay 2.23.0 for Android (Pixel 7, Android 16), against Polygon
mainnet and the CoW Protocol order book. The wallet was the app's own, created in Nimiq Pay.

## What was checked

Coffer was opened in the Nimiq Pay in-app browser. The wallet was asked for each signature the app
uses. Every signature was then checked two ways: the signer recovered from it must be the wallet's
address, and the approval call built from it must succeed on Polygon mainnet when a third party
submits it (`eth_simulateV1`), leaving the allowance at the signed amount.

| Step | Wallet request | Result |
|---|---|---|
| Connect | `eth_requestAccounts` | One sheet, "Connect". Returned the wallet's Polygon address |
| NIM accounts | `listAccounts`, `getBalance` | One sheet, "Connect". Returned the wallet and its HTLC address, balance read |
| Network | `wallet_switchEthereumChain` to `0x89` | One sheet, "Switch Network". The wallet starts on Ethereum (`0x1`) |
| USDT approval | `eth_signTypedData_v4`, `Permit`, salt domain | Signer matches. `permit` succeeds on mainnet, allowance set |
| PAXG approval | `eth_signTypedData_v4`, `MetaTransaction`, salt domain | Signer matches. `executeMetaTransaction` succeeds, allowance set |
| EURe approval | `eth_signTypedData_v4`, `Permit`, chain-id domain | Signer matches. `permit` succeeds on mainnet, allowance set |
| WBTC approval | `eth_signTypedData_v4`, `MetaTransaction`, salt domain | Signer matches. `executeMetaTransaction` succeeds, allowance set |
| Order | `eth_signTypedData_v4`, `Order`, CoW settlement domain | Signer matches. The order book accepted the format and signature, and answered `InsufficientBalance` for the empty wallet |
| Stake | `sendNewStakerTransaction`, 100 NIM to a pool | The wallet took the request and answered `Insufficient funds` for the empty wallet |
| Reopen | none | The statement loads with no sheet: Nimiq Pay remembers the connection |

## What this settles

- Nimiq Pay signs the two domain layouts the four tokens use: the Polygon bridge layout that
  carries the chain id in `salt` (USDT, PAXG, WBTC) and the standard layout with `chainId` (EURe).
- A signed approval needs no gas from the user. Anyone can submit it, and the CoW solver does so as
  the first call of the settlement.
- Typed data that names a chain is signed only on that chain. Coffer asks for the switch to Polygon
  at the first move, so opening the app shows the connection sheets and nothing else.

## Live service checks

`npm run live` repeats the mainnet part from any machine with a fresh key: the four approvals, a
25 USDT quote for each holding within 1.5% of the CoinGecko price, the order format, and the
validator list. Result on 10 November 2026: 9 of 9 pass in 5.8 s.
