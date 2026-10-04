import { describe, expect, it, vi } from "vitest";
import { WALLET_NETWORKS, approveBuilderFeeTypedData, usdSendTypedData, withdraw3TypedData } from "@trading-dashboard/shared/contracts";

import { masterActionSignable, PrivyMasterActionSigner } from "../src/copy/live/privy-master-signer.js";

const account = { walletId: "w", address: `0x${"11".repeat(20)}`, ownerQuorumId: "q" };
const net = WALLET_NETWORKS.testnet;

describe("the copy account's own signer signs only what Orbie needs it for", () => {
  it("allows the return transfer and the builder fee approval, with their exact fields", () => {
    expect(masterActionSignable(usdSendTypedData(net, `0x${"22".repeat(20)}`, "1", 1) as never)).toBe(true);
    expect(masterActionSignable(approveBuilderFeeTypedData(net, `0x${"33".repeat(20)}`, 10, 1) as never)).toBe(true);
  });

  it("refuses any other Hyperliquid user-signed action, or a known one with changed fields, before Privy is asked", async () => {
    const withdraw = withdraw3TypedData(net, `0x${"22".repeat(20)}`, "1", 1);
    expect(masterActionSignable(withdraw as never)).toBe(false);
    const send = usdSendTypedData(net, `0x${"22".repeat(20)}`, "1", 1);
    expect(masterActionSignable({ ...send, message: { ...send.message, extra: "x" } } as never)).toBe(false);
    expect(masterActionSignable({ ...send, types: { ...send.types, "HyperliquidTransaction:UsdSend": send.types["HyperliquidTransaction:UsdSend"].slice(0, 3) } } as never)).toBe(false);
    const agent = { ...send, primaryType: "HyperliquidTransaction:ApproveAgent", types: { "HyperliquidTransaction:ApproveAgent": [{ name: "hyperliquidChain", type: "string" }, { name: "agentAddress", type: "address" }, { name: "agentName", type: "string" }, { name: "nonce", type: "uint64" }] },
      message: { hyperliquidChain: "Testnet", agentAddress: `0x${"44".repeat(20)}`, agentName: "x", nonce: 1 } };
    const fetcher = vi.fn();
    const signer = new PrivyMasterActionSigner({ appId: "app", appSecret: "secret" }, fetcher as never);
    await expect(signer.sign(account, agent as never, "jwt", Date.now() + 5000, () => undefined)).rejects.toThrow("master_action_signing_unavailable");
    await expect(signer.sign(account, withdraw as never, "jwt", Date.now() + 5000, () => undefined)).rejects.toThrow("master_action_signing_unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
