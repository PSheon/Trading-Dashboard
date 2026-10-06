import { describe, expect, it } from "vitest";
import { COPY_MASTER_ACTION_TYPES, WALLET_NETWORKS, agentApprovalTypedData, approveBuilderFeeTypedData, usdSendTypedData, userSetAbstractionTypedData, withdraw3TypedData } from "@trading-dashboard/shared/contracts";

import { masterActionBound, masterActionSignable } from "../src/copy/live/master-action.js";
import { masterPolicyRules } from "../src/copy/live/privy-master-policy.js";

const net = WALLET_NETWORKS.testnet;

describe("the copy account's own signer signs only what Orbie needs it for", () => {
  it("allows the return transfer and the builder fee approval, with their exact fields", () => {
    expect(masterActionSignable(usdSendTypedData(net, `0x${"22".repeat(20)}`, "1", 1) as never)).toBe(true);
    expect(masterActionSignable(approveBuilderFeeTypedData(net, `0x${"33".repeat(20)}`, 10, 1) as never)).toBe(true);
  });

  it("refuses any other Hyperliquid user-signed action, or a known one with changed fields, before Privy is asked", () => {
    const withdraw = withdraw3TypedData(net, `0x${"22".repeat(20)}`, "1", 1);
    expect(masterActionSignable(withdraw as never)).toBe(false);
    const send = usdSendTypedData(net, `0x${"22".repeat(20)}`, "1", 1);
    expect(masterActionSignable({ ...send, message: { ...send.message, extra: "x" } } as never)).toBe(false);
    expect(masterActionSignable({ ...send, types: { ...send.types, "HyperliquidTransaction:UsdSend": send.types["HyperliquidTransaction:UsdSend"].slice(0, 3) } } as never)).toBe(false);
    const agent = { ...send, primaryType: "HyperliquidTransaction:ApproveAgent", types: { "HyperliquidTransaction:ApproveAgent": [{ name: "hyperliquidChain", type: "string" }, { name: "agentAddress", type: "address" }, { name: "agentName", type: "string" }, { name: "nonce", type: "uint64" }] },
      message: { hyperliquidChain: "Testnet", agentAddress: `0x${"44".repeat(20)}`, agentName: "x", nonce: 1 } };
    // Its fields are allowed, but not with a UsdSend's values.
    expect(masterActionBound(agent as never, { network: "testnet", destination: `0x${"22".repeat(20)}` })).toBe(false);
  });

  it("checks the values too: Hyperliquid's chain, its signature chain id, and the bound destination or builder (gap audit 2026-10-05)", () => {
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
    // The network is the caller's: a mainnet send only with a mainnet bound.
    expect(masterActionBound(usdSendTypedData(WALLET_NETWORKS.mainnet, main, "1", 1) as never, { network: "mainnet", destination: main })).toBe(true);
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

  it("one table: every builder, the signer's allow-list and the owner's policy use the same fields (shared COPY_MASTER_ACTION_TYPES)", () => {
    const main = `0x${"22".repeat(20)}`, agent = `0x${"44".repeat(20)}`, builder = `0x${"33".repeat(20)}`;
    const built = [usdSendTypedData(net, main, "1", 1), userSetAbstractionTypedData(net, main, 1), approveBuilderFeeTypedData(net, builder, 10, 1),
      agentApprovalTypedData({ id: "a", strategyId: 7, network: "testnet", accountAddress: main, agentAddress: agent, policyId: "p", workerQuorumId: "w", nonce: 1, expiresAt: 400_000, consentExpiresAt: 300_000 })];
    expect(built.map(data => data.primaryType).sort()).toEqual(Object.keys(COPY_MASTER_ACTION_TYPES).sort());
    for (const data of built) {
      expect((data.types as Record<string, unknown>)[data.primaryType]).toEqual(COPY_MASTER_ACTION_TYPES[data.primaryType]);
      expect(masterActionSignable(data as never)).toBe(true);
    }
    const rules = masterPolicyRules({ ownerMain: main, account: `0x${"55".repeat(20)}`, agent: { address: agent, name: "copy7" }, builder: { address: builder, maxFeeRate: "0.01%" } });
    for (const rule of rules.filter(r => r.method === "eth_signTypedData_v4")) {
      for (const condition of rule.conditions.filter(c => c.field_source === "ethereum_typed_data_message") as { typed_data: { primary_type: keyof typeof COPY_MASTER_ACTION_TYPES; types: Record<string, unknown> } }[])
        expect(condition.typed_data.types[condition.typed_data.primary_type]).toEqual(COPY_MASTER_ACTION_TYPES[condition.typed_data.primary_type]);
    }
  });
});
