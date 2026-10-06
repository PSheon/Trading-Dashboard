import { copyMasterTypes, hyperliquidUserSignedDomain } from "./copy-master-action-contracts.js";
import { WALLET_NETWORKS } from "./wallet-networks.js";

export interface AgentConsentIntent {
  id: string; strategyId: number; network: "testnet" | "mainnet";
  accountAddress: string; agentAddress: string; policyId: string; workerQuorumId: string;
  nonce: number; expiresAt: number; consentExpiresAt: number;
}
const zero = `0x${"00".repeat(20)}` as const;
function validate(input: AgentConsentIntent) {
  if (input.network !== "testnet" || !Number.isSafeInteger(input.strategyId) || input.strategyId < 1 || input.strategyId > 2_147_483_647 ||
    !input.id || input.id.length > 128 || !input.policyId || !input.workerQuorumId ||
    !/^0x[0-9a-fA-F]{40}$/.test(input.accountAddress) || !/^0x[0-9a-fA-F]{40}$/.test(input.agentAddress) ||
    input.accountAddress.toLowerCase() === zero || input.agentAddress.toLowerCase() === zero || input.accountAddress.toLowerCase() === input.agentAddress.toLowerCase() ||
    !Number.isSafeInteger(input.nonce) || !Number.isSafeInteger(input.expiresAt) || !Number.isSafeInteger(input.consentExpiresAt) ||
    input.nonce < 1 || input.consentExpiresAt <= input.nonce || input.consentExpiresAt > input.nonce + 600_000 ||
    input.expiresAt <= input.consentExpiresAt || input.expiresAt > input.nonce + 30 * 86_400_000) throw new Error("invalid_agent_consent");
}
export function agentApprovalTypedData(input: AgentConsentIntent) {
  validate(input);
  const network = WALLET_NETWORKS[input.network];
  return {
    domain: hyperliquidUserSignedDomain(network), types: copyMasterTypes("HyperliquidTransaction:ApproveAgent"), primaryType: "HyperliquidTransaction:ApproveAgent" as const,
    message: { hyperliquidChain: network.hyperliquidChain, agentAddress: input.agentAddress.toLowerCase() as `0x${string}`,
      agentName: `copy${input.strategyId} valid_until ${input.expiresAt}`, nonce: input.nonce },
  };
}
/** The main wallet's payload-specific consent precedes Privy master approval.
 * Identity JWT alone is never treated as permission to approve an agent. */
export function agentOwnerConsentTypedData(input: AgentConsentIntent) {
  validate(input);
  return {
    domain: { name: "Copy Trading Authorization", version: "1", chainId: 421614, verifyingContract: zero },
    types: { CopyAgentConsent: [
      { name: "operationId", type: "string" }, { name: "strategyId", type: "uint64" },
      { name: "account", type: "address" }, { name: "agent", type: "address" }, { name: "network", type: "string" },
      { name: "policyId", type: "string" }, { name: "workerQuorumId", type: "string" },
      { name: "validUntil", type: "uint64" }, { name: "nonce", type: "uint64" }, { name: "consentExpiresAt", type: "uint64" },
    ] }, primaryType: "CopyAgentConsent" as const,
    message: { operationId: input.id, strategyId: input.strategyId, account: input.accountAddress.toLowerCase() as `0x${string}`,
      agent: input.agentAddress.toLowerCase() as `0x${string}`, network: input.network, policyId: input.policyId,
      workerQuorumId: input.workerQuorumId, validUntil: input.expiresAt, nonce: input.nonce, consentExpiresAt: input.consentExpiresAt },
  };
}
