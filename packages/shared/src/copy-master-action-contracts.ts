import type { WalletNetworkConfig } from "./wallet-networks.js";

/**
 * The Hyperliquid user-signed actions a copy account signs, with their exact
 * EIP-712 fields, in one table: the worker's signer allows only these shapes
 * (apps/api live/master-action.ts), the owner's Privy policy binds the same
 * fields (live/privy-master-policy.ts), and every builder below takes its
 * types from here. A copy account is signed for by the worker under the
 * owner's policy only (the one signing model, 2026-10-07): a UsdSend to the
 * owner's main wallet, the standard account mode, the consented agent's
 * approval and (when the fee is above 0) the consented builder fee.
 */
export const COPY_MASTER_ACTION_TYPES = {
  "HyperliquidTransaction:UsdSend": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }],
  "HyperliquidTransaction:UserSetAbstraction": [{ name: "hyperliquidChain", type: "string" }, { name: "user", type: "address" }, { name: "abstraction", type: "string" }, { name: "nonce", type: "uint64" }],
  "HyperliquidTransaction:ApproveAgent": [{ name: "hyperliquidChain", type: "string" }, { name: "agentAddress", type: "address" }, { name: "agentName", type: "string" }, { name: "nonce", type: "uint64" }],
  "HyperliquidTransaction:ApproveBuilderFee": [{ name: "hyperliquidChain", type: "string" }, { name: "maxFeeRate", type: "string" }, { name: "builder", type: "address" }, { name: "nonce", type: "uint64" }],
} as const satisfies Record<string, readonly { name: string; type: string }[]>;
export type CopyMasterPrimaryType = keyof typeof COPY_MASTER_ACTION_TYPES;
/** A fresh, mutable copy of one action's `types` entry. */
export function copyMasterTypes<P extends CopyMasterPrimaryType>(primary: P): { [K in P]: { name: string; type: string }[] } {
  return { [primary]: COPY_MASTER_ACTION_TYPES[primary].map(field => ({ ...field })) } as { [K in P]: { name: string; type: string }[] };
}
const ZERO = `0x${"00".repeat(20)}` as `0x${string}`;
/** Hyperliquid's domain for user-signed actions on `network`. */
export function hyperliquidUserSignedDomain(network: WalletNetworkConfig) {
  return { name: "HyperliquidSignTransaction", version: "1", chainId: Number.parseInt(network.signatureChainId, 16), verifyingContract: ZERO };
}

/** The standard account mode (`userSetAbstraction` to "disabled"), with
 * exactly its signed fields. */
export function userSetAbstractionTypedData(network: WalletNetworkConfig, user: string, nonce: number) {
  return {
    domain: hyperliquidUserSignedDomain(network), types: copyMasterTypes("HyperliquidTransaction:UserSetAbstraction"),
    primaryType: "HyperliquidTransaction:UserSetAbstraction" as const,
    message: { hyperliquidChain: network.hyperliquidChain, user: user.toLowerCase() as `0x${string}`, abstraction: "disabled", nonce },
  };
}
