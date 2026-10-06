import { describe, expect, it } from "vitest";
import { agentApprovalTypedData } from "../src/copy/copy-agent-consent.js";

const intent = {
  id: "operation-1", strategyId: 42, network: "testnet" as const,
  accountAddress: `0x${"22".repeat(20)}`, agentAddress: `0x${"33".repeat(20)}`,
  policyId: "owner-policy", workerQuorumId: "worker-quorum",
  nonce: 1_790_000_000_000, expiresAt: 1_790_604_800_000, consentExpiresAt: 1_790_000_300_000,
};
describe("the copy agent's approval typed data", () => {
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
  it("does not construct a mainnet approval yet", () => {
    expect(() => agentApprovalTypedData({ ...intent, network: "mainnet" })).toThrow();
  });
});
