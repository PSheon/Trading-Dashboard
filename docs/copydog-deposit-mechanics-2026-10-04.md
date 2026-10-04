# How CopyDog moves a deposit into Hyperliquid — observed on-chain, 2026-10-04

Paul deposited 11 USDC (Arbitrum One) to his CopyDog Privy wallet (`0xA442…Fcaa`) from his test address. Everything below is read from public Arbitrum and Hyperliquid data; nothing was done in his CopyDog session.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 06:57:13 | 11 USDC arrives in the Privy wallet on Arbitrum (block 511540396). Wallet holds no ETH. |
| 06:58:38 | One transaction moves the 11 USDC from the wallet to Hyperliquid's Bridge2 contract `0x2df1c51e09aecf9cacb7bc98cb1742757f163df7` (block 511540705, tx `0xc418901e…225b2c`). |
| 06:58:46 | Hyperliquid credits `deposit 11.0` to the same address's perp account (account value 11.0). |

Arrival to tradable: about 93 s. Nothing was deducted (11.0 in, 11.0 credited).

## The bridge transaction

- **Type 4 (EIP-7702)** with one authorization signed by the wallet's own key: the wallet delegated its code to `0xd6cedde84be40893d153be9d467cd6ad37875b28` (a 24 KB smart-account implementation). After it, `eth_getCode(wallet)` is `0xef0100d6ce…` and the wallet's nonce is 1.
- **Sent to the ERC-4337 EntryPoint v0.7** `0x0000000071727De22E5E9d8BAf0edAc6f37da032` with `handleOps` (selector `0x765e827f`), from a bundler account `0xe196…0ce1` (nonce ≈ 36,700, i.e. a busy relayer).
- **UserOperation**: sender = the wallet, paymaster = none, `actualGasCost` = 0. The user operation paid no gas; the bundler paid the Arbitrum fee itself (0.0000027 ETH, about $0.01). So gas is sponsored by whoever runs that bundler, presumably billed off-chain.
- **Call**: a plain USDC `transfer(wallet → Bridge2, 11)`. Bridge2 credits the sender, so the deposit lands on the user's own Hyperliquid account. No permit, no intermediary account, no platform custody.

## What this means

- CopyDog does use the bridge; it hides it. The wallet's key signed both the 7702 authorization and the user operation without the user pressing anything in a bridge flow, about 85 s after the funds arrived — consistent with a backend watcher signing through Privy server-side signing and a sponsored bundler. Whether the signature came from CopyDog's server or from a browser tab that was open cannot be told from chain data.
- For Orbie the equivalent is: detect USDC on the user's embedded wallet → send a sponsored EIP-7702 user operation that transfers the USDC to Bridge2 → wait for the Hyperliquid credit. It needs Privy gas sponsorship for Arbitrum (with a spend cap) and server-side signing permission limited to that one call.

## Not determined

Which provider runs the bundler and the 7702 implementation; CopyDog's Privy policy; the minimum it bridges; what happens to amounts below Hyperliquid's 5 USDC bridge minimum.
