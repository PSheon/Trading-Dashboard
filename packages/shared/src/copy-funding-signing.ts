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
