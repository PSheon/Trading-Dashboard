import type { WalletNetworkConfig } from "./wallet-networks.js";

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
    primaryType: "HyperliquidTransaction:Withdraw" as const,
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
  if (!/^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i.test(signature)) throw new Error("Invalid signature");
  const hex = signature.slice(2);
  let v = Number.parseInt(hex.slice(128, 130), 16);
  if (v < 27) v += 27;
  return { r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}`, v };
}
