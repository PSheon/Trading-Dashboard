/**
 * Per-network constants of the user wallet, shared by the api (balance reads)
 * and the browser (signing). Sources, checked 2026-09-30:
 * - Hyperliquid docs, For developers → API → USDC ("Legacy Bridge"): bridge
 *   contracts and USDC tokens for both networks, 5 USDC minimum deposit
 *   (less is lost), `withdraw3` payload, 3–4 minute withdrawals.
 * - Hyperliquid docs, API → Exchange endpoint: user-signed actions carry
 *   `hyperliquidChain` "Mainnet" / "Testnet" and a `signatureChainId`.
 */
export const WALLET_NETWORKS = {
  mainnet: {
    hyperliquidChain: "Mainnet",
    infoUrl: "https://api.hyperliquid.xyz/info",
    exchangeUrl: "https://api.hyperliquid.xyz/exchange",
    arbitrumChainId: 42161,
    arbitrumRpcUrl: "https://arb1.arbitrum.io/rpc",
    /** 42161 in hex: the chain id the EIP-712 domain is signed with. */
    signatureChainId: "0xa4b1",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    bridge: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7",
    chainLabel: "Arbitrum",
    explorer: "https://arbiscan.io",
  },
  testnet: {
    hyperliquidChain: "Testnet",
    infoUrl: "https://api.hyperliquid-testnet.xyz/info",
    exchangeUrl: "https://api.hyperliquid-testnet.xyz/exchange",
    arbitrumChainId: 421614,
    arbitrumRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    /** 421614 in hex. */
    signatureChainId: "0x66eee",
    /** "USDC2", the testnet bridge's token. */
    usdc: "0x1baAbB04529D43a73232B713C0FE471f7c7334d5",
    bridge: "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89",
    chainLabel: "Arbitrum Sepolia",
    explorer: "https://sepolia.arbiscan.io",
  },
} as const;

export type WalletNetworkConfig = (typeof WALLET_NETWORKS)[keyof typeof WALLET_NETWORKS];
/** A Hyperliquid network. A deployment executes actual copies on exactly one
 * (HYPERLIQUID_NETWORK); rows of the other stay readable history. */
export type HyperliquidNetwork = keyof typeof WALLET_NETWORKS;
export const HYPERLIQUID_NETWORKS = ["testnet", "mainnet"] as const satisfies readonly HyperliquidNetwork[];
/** The leaders' networks a deployment on `network` may copy: a testnet
 * deployment copies mainnet and testnet leaders (a mainnet leader through a
 * mainnet price reference); a mainnet deployment copies mainnet leaders only. */
export function liveSourceNetworks(network: HyperliquidNetwork): readonly HyperliquidNetwork[] {
  return network === "mainnet" ? ["mainnet"] : ["mainnet", "testnet"];
}
export function isHyperliquidNetwork(value: unknown): value is HyperliquidNetwork { return value === "testnet" || value === "mainnet"; }
/** `copy_strategies.mode` of an actual copy: named "testnet" when only
 * testnet existed, it means "actual" on the deployment's network (the
 * strategy's own network is its account's). */
export const ACTUAL_STRATEGY_MODE = "testnet" as const;

/** Bridge2 credits nothing below this; a smaller transfer is lost. */
export const MIN_BRIDGE_USDC = 5;
/** Hyperliquid's flat withdrawal fee, taken from the withdrawn amount. */
export const WITHDRAW_FEE_USDC = 1;
export const USDC_DECIMALS = 6;
