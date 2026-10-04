import type { WalletNetworkConfig } from "./wallet-networks.js";
import { splitSignature } from "./wallet-withdrawal-signing.js";

/** Human-readable usdSend signing. Source and network are server-bound. */
export function usdSendTypedData(network: WalletNetworkConfig, destination: string, amount: string, time: number) {
  return {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: Number.parseInt(network.signatureChainId, 16), verifyingContract: "0x0000000000000000000000000000000000000000" as const },
    types: { "HyperliquidTransaction:UsdSend": [
      { name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" },
      { name: "amount", type: "string" }, { name: "time", type: "uint64" },
    ] },
    primaryType: "HyperliquidTransaction:UsdSend" as const,
    message: { hyperliquidChain: network.hyperliquidChain, destination: destination.toLowerCase(), amount, time },
  };
}
export function usdSendRequest(network: WalletNetworkConfig, destination: string, amount: string, time: number, signature: string) {
  return { action: { type: "usdSend", hyperliquidChain: network.hyperliquidChain, signatureChainId: network.signatureChainId, destination: destination.toLowerCase(), amount, time }, nonce: time, signature: splitSignature(signature) };
}

/** Hyperliquid's percentage string for a fee in tenths of a basis point
 * (100 tenths = 10 bps = "0.1%"). */
export function builderFeePercent(tenthsBps: number): string {
  if (!Number.isInteger(tenthsBps) || tenthsBps < 1 || tenthsBps > 100) throw new Error("invalid_builder_fee");
  return `${(tenthsBps / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`;
}
/** approveBuilderFee, signed by the trading account (a user-signed action). */
export function approveBuilderFeeTypedData(network: WalletNetworkConfig, builder: string, tenthsBps: number, nonce: number) {
  return {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: Number.parseInt(network.signatureChainId, 16), verifyingContract: "0x0000000000000000000000000000000000000000" as const },
    types: { "HyperliquidTransaction:ApproveBuilderFee": [
      { name: "hyperliquidChain", type: "string" }, { name: "maxFeeRate", type: "string" },
      { name: "builder", type: "address" }, { name: "nonce", type: "uint64" },
    ] },
    primaryType: "HyperliquidTransaction:ApproveBuilderFee" as const,
    message: { hyperliquidChain: network.hyperliquidChain, maxFeeRate: builderFeePercent(tenthsBps), builder: builder.toLowerCase() as `0x${string}`, nonce },
  };
}
export function approveBuilderFeeRequest(network: WalletNetworkConfig, builder: string, tenthsBps: number, nonce: number, signature: string) {
  return { action: { type: "approveBuilderFee", hyperliquidChain: network.hyperliquidChain, signatureChainId: network.signatureChainId,
    maxFeeRate: builderFeePercent(tenthsBps), builder: builder.toLowerCase(), nonce }, nonce, signature: splitSignature(signature) };
}
