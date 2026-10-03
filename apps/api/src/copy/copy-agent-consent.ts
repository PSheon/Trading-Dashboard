import { verifyTypedData } from "viem";
import { agentOwnerConsentTypedData, type AgentConsentIntent } from "@trading-dashboard/shared/contracts";
export { agentApprovalTypedData, agentOwnerConsentTypedData, type AgentConsentIntent } from "@trading-dashboard/shared/contracts";

export async function verifyAgentOwnerConsent(ownerAddress: string, intent: AgentConsentIntent, signature: string, now = Date.now()): Promise<boolean> {
  try {
    if (!Number.isSafeInteger(now) || now < intent.nonce || now >= intent.consentExpiresAt ||
      !/^0x[0-9a-fA-F]{40}$/.test(ownerAddress) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
    return await verifyTypedData({ address: ownerAddress as `0x${string}`, ...agentOwnerConsentTypedData(intent), signature: signature as `0x${string}` });
  } catch { return false; }
}
