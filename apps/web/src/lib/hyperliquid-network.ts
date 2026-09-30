import { USDC_DECIMALS, WALLET_NETWORKS, type WalletNetwork, type WalletNetworkConfig } from "@trading-dashboard/shared/contracts";

/**
 * What the browser needs to sign a wallet action. Which network is live
 * comes from the api (`GET /me/wallet` → `network`, from
 * HYPERLIQUID_NETWORK, default testnet), never from a browser setting, so a
 * page can't be talked into signing on mainnet. The addresses live in
 * `@trading-dashboard/shared` (wallet-networks.ts) with their sources.
 */
export { MIN_BRIDGE_USDC, WITHDRAW_FEE_USDC } from "@trading-dashboard/shared/contracts";

export function networkConfig(network: WalletNetwork): WalletNetworkConfig {
  return WALLET_NETWORKS[network];
}

/** The two Arbitrum chains, in the shape Privy's `supportedChains` takes
 * (viem `Chain`), without adding viem as a direct dependency. */
export const ARBITRUM_CHAINS = [
  {
    id: 42161,
    name: "Arbitrum One",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [WALLET_NETWORKS.mainnet.arbitrumRpcUrl] } },
    blockExplorers: { default: { name: "Arbiscan", url: WALLET_NETWORKS.mainnet.explorer } },
  },
  {
    id: 421614,
    name: "Arbitrum Sepolia",
    nativeCurrency: { name: "Arbitrum Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [WALLET_NETWORKS.testnet.arbitrumRpcUrl] } },
    blockExplorers: { default: { name: "Arbiscan", url: WALLET_NETWORKS.testnet.explorer } },
    testnet: true,
  },
] as const;

/** `transfer(address,uint256)` calldata, hand-encoded (selector a9059cbb). */
export function erc20TransferData(to: string, amountUnits: bigint): `0x${string}` {
  const address = to.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(address)) throw new Error("Invalid address");
  if (amountUnits <= 0n) throw new Error("Invalid amount");
  return `0xa9059cbb${address.padStart(64, "0")}${amountUnits.toString(16).padStart(64, "0")}`;
}

/** USDC decimal string ("12.5") → integer units (12500000n), exact. */
export function usdcToUnits(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{0,6}))?$/.exec(amount.trim());
  if (!match) throw new Error("Invalid amount");
  return BigInt(match[1]!) * 10n ** BigInt(USDC_DECIMALS) + BigInt((match[2] ?? "").padEnd(USDC_DECIMALS, "0"));
}

/** Largest USDC amount ≤ `value` with at most 6 decimals, as Hyperliquid
 * wants it: no exponent, no trailing zeros ("12.5", not "12.500000"). */
export function usdcString(value: number): string {
  const units = Math.floor(value * 10 ** USDC_DECIMALS + 1e-6);
  const whole = Math.floor(units / 10 ** USDC_DECIMALS);
  const frac = String(units % 10 ** USDC_DECIMALS).padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** EIP-712 message of a `withdraw3` action (Hyperliquid docs → API → USDC).
 * `time` is the nonce in ms; the destination is lowercased as the signing
 * docs recommend. */
export function withdraw3TypedData(network: WalletNetworkConfig, destination: string, amount: string, time: number) {
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: Number.parseInt(network.signatureChainId, 16),
      verifyingContract: "0x0000000000000000000000000000000000000000" as const,
    },
    types: {
      "HyperliquidTransaction:Withdraw": [
        { name: "hyperliquidChain", type: "string" },
        { name: "destination", type: "string" },
        { name: "amount", type: "string" },
        { name: "time", type: "uint64" },
      ],
    },
    primaryType: "HyperliquidTransaction:Withdraw",
    message: { hyperliquidChain: network.hyperliquidChain, destination: destination.toLowerCase(), amount, time },
  };
}

/** The signed `withdraw3` request body for POST /exchange. */
export function withdraw3Request(network: WalletNetworkConfig, destination: string, amount: string, time: number, signature: string) {
  return {
    action: {
      type: "withdraw3",
      hyperliquidChain: network.hyperliquidChain,
      signatureChainId: network.signatureChainId,
      destination: destination.toLowerCase(),
      amount,
      time,
    },
    nonce: time,
    signature: splitSignature(signature),
  };
}

/** 65-byte 0x signature → Hyperliquid's `{r, s, v}`. */
export function splitSignature(signature: string): { r: string; s: string; v: number } {
  const hex = signature.replace(/^0x/, "");
  if (hex.length !== 130) throw new Error("Unexpected signature length");
  let v = Number.parseInt(hex.slice(128, 130), 16);
  if (v < 27) v += 27;
  return { r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}`, v };
}
