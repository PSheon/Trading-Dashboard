import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { agentApprovalTypedData, agentOwnerConsentTypedData, verifyAgentOwnerConsent } from "../src/copy/copy-agent-consent.js";

const owner = privateKeyToAccount(`0x${"01".repeat(32)}`);
const intent = {
  id: "operation-1", strategyId: 42, network: "testnet" as const,
  accountAddress: `0x${"22".repeat(20)}`, agentAddress: `0x${"33".repeat(20)}`,
  policyId: "owner-policy", workerQuorumId: "worker-quorum",
  nonce: 1_790_000_000_000, expiresAt: 1_790_604_800_000, consentExpiresAt: 1_790_000_300_000,
};
describe("explicit owner consent for dedicated copy agents", () => {
  it("approval names the exact agent, testnet and finite expiry with independent EIP712 fields", () => {
    expect(agentApprovalTypedData(intent)).toEqual({
      domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 421614, verifyingContract: `0x${"00".repeat(20)}` },
      types: { "HyperliquidTransaction:ApproveAgent": [
        { name: "hyperliquidChain", type: "string" }, { name: "agentAddress", type: "address" },
        { name: "agentName", type: "string" }, { name: "nonce", type: "uint64" },
      ] }, primaryType: "HyperliquidTransaction:ApproveAgent",
      message: { hyperliquidChain: "Testnet", agentAddress: `0x${"33".repeat(20)}`, agentName: "copy42 valid_until 1790604800000", nonce: 1_790_000_000_000 },
    });
  });
  it("a user signature binds the exact account, agent, policy, worker and consent deadline", async () => {
    const typed = agentOwnerConsentTypedData(intent);
    expect(typed.message).toEqual({ operationId: "operation-1", strategyId: 42,
      account: `0x${"22".repeat(20)}`, agent: `0x${"33".repeat(20)}`, network: "testnet",
      policyId: "owner-policy", workerQuorumId: "worker-quorum", validUntil: 1_790_604_800_000,
      nonce: 1_790_000_000_000, consentExpiresAt: 1_790_000_300_000 });
    const signature = await owner.signTypedData(typed);
    expect(await verifyAgentOwnerConsent(owner.address, intent, signature, intent.nonce + 1)).toBe(true);
    for (const patch of [{ id: "other-operation" }, { strategyId: 43 }, { accountAddress: `0x${"44".repeat(20)}` },
      { agentAddress: `0x${"55".repeat(20)}` }, { policyId: "other-policy" }, { workerQuorumId: "other-worker" },
      { expiresAt: intent.expiresAt + 1 }, { nonce: intent.nonce + 1 }]) {
      expect(await verifyAgentOwnerConsent(owner.address, { ...intent, ...patch }, signature, intent.nonce + 2)).toBe(false);
    }
  });
  it("rejects expired or not-yet-valid consent and malformed signatures", async () => {
    const signature = await owner.signTypedData(agentOwnerConsentTypedData(intent));
    expect(await verifyAgentOwnerConsent(owner.address, intent, signature, intent.consentExpiresAt)).toBe(false);
    expect(await verifyAgentOwnerConsent(owner.address, intent, signature, intent.nonce - 1)).toBe(false);
    expect(await verifyAgentOwnerConsent(owner.address, intent, "0xbad", intent.nonce + 1)).toBe(false);
  });
  it("does not accept a signature by a different account", async () => {
    const signature = await owner.signTypedData(agentOwnerConsentTypedData(intent));
    expect(await verifyAgentOwnerConsent(`0x${"66".repeat(20)}`, intent, signature, intent.nonce + 1)).toBe(false);
  });
  it("does not construct a mainnet approval or accept unsafe temporal identity", () => {
    expect(() => agentApprovalTypedData({ ...intent, network: "mainnet" })).toThrow();
    expect(() => agentOwnerConsentTypedData({ ...intent, expiresAt: intent.nonce })).toThrow();
    expect(() => agentOwnerConsentTypedData({ ...intent, nonce: NaN })).toThrow();
  });
});
