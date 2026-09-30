/**
 * Everything the browser needs to sign a Hyperliquid wallet action on one
 * network. Which network is live comes from the api (`GET /me/wallet` →
 * `network`, from HYPERLIQUID_NETWORK, default testnet), never from a
 * browser setting, so the page can't be talked into signing on mainnet.
 *
 * Sources (checked 2026-09-30):
 * - Hyperliquid docs, For developers → API → USDC (legacy Bridge2): bridge
 *   and USDC addresses for both networks, 5 USDC minimum, `withdraw3`
 *   EIP-712 payload, nonce must equal `time`.
 * - Hyperliquid docs, API → Signing: user-signed actions use the domain
 *   `HyperliquidSignTransaction` v1 with `signatureChainId` as chainId and a
 *   zero verifyingContract.
 */
export type HyperliquidNetwork = "mainnet" | "testnet";

export interface NetworkConfig {
  /** `hyperliquidChain` in user-signed actions. */
  hyperliquidChain: "Mainnet" | "Testnet";
  exchangeUrl: string;
  /** Arbitrum chain holding the deposit USDC. */
  arbitrumChainId: number;
  /** Chain id the EIP-712 domain is signed with (hex, as the action carries it). */
  signatureChainId: `0x${string}`;
  usdc: `0x${string}`;
  bridge: `0x${string}`;
  chainLabel: "Arbitrum" | "Arbitrum Sepolia";
  explorer: string;
  appUrl: string;
}

export const NETWORKS: Record<HyperliquidNetwork, NetworkConfig> = {
  mainnet: {
    hyperliquidChain: "Mainnet",
    exchangeUrl: "https://api.hyperliquid.xyz/exchange",
    arbitrumChainId: 42161,
    signatureChainId: "0xa4b1",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    bridge: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7",
    chainLabel: "Arbitrum",
    explorer: "https://arbiscan.io",
    appUrl: "https://app.hyperliquid.xyz",
  },
  testnet: {
    hyperliquidChain: "Testnet",
    exchangeUrl: "https://api.hyperliquid-testnet.xyz/exchange",
    arbitrumChainId: 421614,
    signatureChainId: "0x66eee",
    usdc: "0x1baAbB04529D43a73232B713C0FE471f7c7334d5",
    bridge: "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89",
    chainLabel: "Arbitrum Sepolia",
    explorer: "https://sepolia.arbiscan.io",
    appUrl: "https://app.hyperliquid-testnet.xyz",
  },
};

/** Bridge2 credits nothing below this; smaller transfers are lost. */
export const MIN_BRIDGE_USDC = 5;
/** Hyperliquid's flat withdrawal fee, taken from the withdrawn amount. */
export const WITHDRAW_FEE_USDC = 1;
export const USDC_DECIMALS = 6;

/** The two Arbitrum chains, in the shape Privy's `supportedChains` takes
 * (viem `Chain`), without adding viem as a direct dependency. */
export const ARBITRUM_CHAINS = [
  {
    id: 42161,
    name: "Arbitrum One",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://arb1.arbitrum.io/rpc"] } },
    blockExplorers: { default: { name: "Arbiscan", url: "https://arbiscan.io" } },
  },
  {
    id: 421614,
    name: "Arbitrum Sepolia",
    nativeCurrency: { name: "Arbitrum Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://sepolia-rollup.arbitrum.io/rpc"] } },
    blockExplorers: { default: { name: "Arbiscan", url: "https://sepolia.arbiscan.io" } },
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
  return BigInt(match[1]) * 10n ** 6n + BigInt((match[2] ?? "").padEnd(USDC_DECIMALS, "0"));
}

/** The EIP-712 message for a `withdraw3` action (Hyperliquid docs, USDC). */
export function withdraw3TypedData(network: NetworkConfig, destination: string, amount: string, time: number) {
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
    message: { hyperliquidChain: network.hyperliquidChain, destination, amount, time },
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
