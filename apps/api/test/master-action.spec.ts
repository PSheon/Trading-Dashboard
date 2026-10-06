import { describe, expect, it } from "vitest";
import { hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WALLET_NETWORKS, approveBuilderFeeTypedData, copyMasterActionRequestSchema, usdSendTypedData, userSetAbstractionTypedData, withdraw3TypedData } from "@trading-dashboard/shared/contracts";

import { masterActionBound, masterActionRequest, masterActionSignable, masterSignatureRefusal } from "../src/copy/live/master-action.js";

const net = WALLET_NETWORKS.testnet;
const copyAccount = privateKeyToAccount(`0x${"07".repeat(32)}`), mainWallet = privateKeyToAccount(`0x${"08".repeat(32)}`);
const account = copyAccount.address.toLowerCase();

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
    // Never prepared for the browser, and never taken from it.
    expect(() => masterActionRequest(account, agent as never, { network: "testnet", destination: `0x${"22".repeat(20)}` }, Date.now() + 5000)).toThrow("master_action_not_signable");
    expect(() => masterActionRequest(account, withdraw as never, { network: "testnet", destination: `0x${"22".repeat(20)}` }, Date.now() + 5000)).toThrow("master_action_not_signable");
    expect(await masterSignatureRefusal(account, withdraw as never, { network: "testnet", destination: `0x${"22".repeat(20)}` }, await copyAccount.signTypedData(withdraw as never))).toBe("master_action_not_signable");
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
    expect(() => masterActionRequest(account, send as never, { network: "testnet", destination: `0x${"55".repeat(20)}` }, Date.now() + 5000)).toThrow("master_action_not_signable");
    expect(() => masterActionRequest(account, usdSendTypedData(WALLET_NETWORKS.mainnet, main, "1", 1) as never, { network: "testnet", destination: main }, Date.now() + 5000)).toThrow("master_action_not_signable");
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

  it("prepares the exact action for the owner's browser, and takes only the copy account's signature of exactly it", async () => {
    const main = mainWallet.address.toLowerCase(), send = usdSendTypedData(net, main, "12.5", 1_800_000_000_000);
    const request = masterActionRequest(copyAccount.address, send as never, { network: "testnet", destination: main }, 1_800_000_300_000);
    expect(copyMasterActionRequestSchema.parse(request)).toEqual(request);
    expect(request).toMatchObject({ kind: "usd_send", account, expiresAt: 1_800_000_300_000, typedData: send, digest: hashTypedData(send) });
    const mode = userSetAbstractionTypedData(net, account, 7);
    expect(masterActionRequest(account, mode as never, { network: "testnet", account }, 1).kind).toBe("account_mode");
    const bound = { network: "testnet" as const, destination: main };
    expect(await masterSignatureRefusal(account, send as never, bound, await copyAccount.signTypedData(send))).toBeNull();
    // The main wallet's signature, another payload, a malformed one.
    expect(await masterSignatureRefusal(account, send as never, bound, await mainWallet.signTypedData(send))).toBe("master_signature_invalid");
    expect(await masterSignatureRefusal(account, send as never, bound, await copyAccount.signTypedData({ ...send, message: { ...send.message, amount: "13" } }))).toBe("master_signature_invalid");
    expect(await masterSignatureRefusal(account, send as never, bound, "0xbad")).toBe("master_signature_invalid");
    // The right signature for a destination the caller didn't bind.
    expect(await masterSignatureRefusal(account, send as never, { network: "testnet", destination: `0x${"55".repeat(20)}` }, await copyAccount.signTypedData(send))).toBe("master_action_not_signable");
  });
});
