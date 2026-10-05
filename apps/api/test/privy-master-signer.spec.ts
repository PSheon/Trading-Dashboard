import { describe, expect, it, vi } from "vitest";
import { WALLET_NETWORKS, approveBuilderFeeTypedData, usdSendTypedData, withdraw3TypedData } from "@trading-dashboard/shared/contracts";

import { masterActionBound, masterActionSignable, PrivyMasterActionSigner } from "../src/copy/live/privy-master-signer.js";

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
    await expect(signer.sign(account, agent as never, "jwt", Date.now() + 5000, () => undefined, { network: "testnet", destination: `0x${"22".repeat(20)}` })).rejects.toThrow("master_action_signing_unavailable");
    await expect(signer.sign(account, withdraw as never, "jwt", Date.now() + 5000, () => undefined, { network: "testnet", destination: `0x${"22".repeat(20)}` })).rejects.toThrow("master_action_signing_unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("checks the values too: Hyperliquid's testnet chain, its signature chain id, and the bound destination or builder (gap audit 2026-10-05)", async () => {
    const main = `0x${"22".repeat(20)}`, builder = `0x${"33".repeat(20)}`;
    const send = usdSendTypedData(net, main, "1", 1);
    expect(masterActionBound(send as never, { network: "testnet", destination: main.toUpperCase().replace("0X", "0x") })).toBe(true);
    expect(masterActionBound(send as never, { network: "testnet", destination: `0x${"55".repeat(20)}` })).toBe(false);
    expect(masterActionBound(send as never, { network: "testnet" })).toBe(false);
    expect(masterActionBound(send as never, { network: "mainnet" } as never)).toBe(false);
    expect(masterActionBound(usdSendTypedData(WALLET_NETWORKS.mainnet, main, "1", 1) as never, { network: "testnet", destination: main })).toBe(false);
    expect(masterActionBound({ ...send, domain: { ...send.domain, chainId: 42161 } } as never, { network: "testnet", destination: main })).toBe(false);
    expect(masterActionBound({ ...send, message: { ...send.message, hyperliquidChain: "Mainnet" } } as never, { network: "testnet", destination: main })).toBe(false);
    expect(masterActionBound({ ...send, message: { ...send.message, destination: main.toUpperCase() } } as never, { network: "testnet", destination: main })).toBe(false);
    const fee = approveBuilderFeeTypedData(net, builder, 10, 1);
    expect(masterActionBound(fee as never, { network: "testnet", builder })).toBe(true);
    expect(masterActionBound(fee as never, { network: "testnet", builder: main })).toBe(false);
    expect(masterActionBound(fee as never, { network: "testnet", destination: builder })).toBe(false);
    const fetcher = vi.fn();
    const signer = new PrivyMasterActionSigner({ appId: "app", appSecret: "secret" }, fetcher as never);
    await expect(signer.sign(account, send as never, "jwt", Date.now() + 5000, () => undefined, { network: "testnet", destination: `0x${"55".repeat(20)}` })).rejects.toThrow("master_action_signing_unavailable");
    await expect(signer.sign(account, usdSendTypedData(WALLET_NETWORKS.mainnet, main, "1", 1) as never, "jwt", Date.now() + 5000, () => undefined, { network: "testnet", destination: main })).rejects.toThrow("master_action_signing_unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a one-click setup's mode and agent approval: only the standard mode for the bound account, only the consented agent and name", () => {
    const account = `0x${"22".repeat(20)}`, agentAddress = `0x${"44".repeat(20)}`, name = "copy7 valid_until 1790000000000";
    const domain = usdSendTypedData(net, account, "1", 1).domain;
    const mode = { domain, primaryType: "HyperliquidTransaction:UserSetAbstraction", types: { "HyperliquidTransaction:UserSetAbstraction": [{ name: "hyperliquidChain", type: "string" }, { name: "user", type: "address" }, { name: "abstraction", type: "string" }, { name: "nonce", type: "uint64" }] },
      message: { hyperliquidChain: "Testnet", user: account, abstraction: "disabled", nonce: 1 } };
    expect(masterActionSignable(mode as never)).toBe(true);
    expect(masterActionBound(mode as never, { network: "testnet", account })).toBe(true);
    expect(masterActionBound(mode as never, { network: "testnet", account: agentAddress })).toBe(false);
    expect(masterActionBound(mode as never, { network: "testnet" })).toBe(false);
    expect(masterActionBound({ ...mode, message: { ...mode.message, abstraction: "unifiedAccount" } } as never, { network: "testnet", account })).toBe(false);
    const agent = { domain, primaryType: "HyperliquidTransaction:ApproveAgent", types: { "HyperliquidTransaction:ApproveAgent": [{ name: "hyperliquidChain", type: "string" }, { name: "agentAddress", type: "address" }, { name: "agentName", type: "string" }, { name: "nonce", type: "uint64" }] },
      message: { hyperliquidChain: "Testnet", agentAddress, agentName: name, nonce: 1 } };
    expect(masterActionSignable(agent as never)).toBe(true);
    expect(masterActionBound(agent as never, { network: "testnet", agent: { address: agentAddress, name } })).toBe(true);
    expect(masterActionBound(agent as never, { network: "testnet", agent: { address: account, name } })).toBe(false);
    expect(masterActionBound(agent as never, { network: "testnet", agent: { address: agentAddress, name: "copy7 valid_until 1" } })).toBe(false);
    expect(masterActionBound({ ...agent, message: { ...agent.message, hyperliquidChain: "Mainnet" } } as never, { network: "testnet", agent: { address: agentAddress, name } })).toBe(false);
  });
});
