import { agentApprovalTypedData, usdSendTypedData, userSetAbstractionTypedData, WALLET_NETWORKS } from "@trading-dashboard/shared/contracts";

/** The copy account's signature the tests' wallet returns for any prepared action. */
export const MASTER_SIGNATURE = `0x${"bb".repeat(65)}`;
const digest = `0x${"ab".repeat(32)}`;
const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Adds the action the api prepares for the copy account (`masterAction`) to
 * a mocked challenge or return reservation, derived from its intent or
 * consent exactly as the api derives it, so UI tests that mock those
 * responses by hand get what the real api sends.
 */
export function withMasterAction(path: unknown, value: unknown): unknown {
  if (!value || typeof value !== "object" || "masterAction" in value || typeof path !== "string") return value;
  const body = value as { intent?: Record<string, unknown>; consent?: Record<string, unknown> };
  if (path.endsWith("/challenge") && body.intent && "operationId" in body.intent) {
    const intent = body.intent as { accountAddress: string; nonce: number; consentExpiresAt: number };
    return { ...value, masterAction: { kind: "account_mode", account: intent.accountAddress, typedData: json(userSetAbstractionTypedData(WALLET_NETWORKS.testnet, intent.accountAddress, intent.nonce)), digest, expiresAt: intent.consentExpiresAt } };
  }
  if (path.endsWith("/challenge") && body.intent && "policyId" in body.intent) {
    const intent = body.intent as unknown as Parameters<typeof agentApprovalTypedData>[0];
    try { return { ...value, masterAction: { kind: "agent_approval", account: intent.accountAddress, typedData: json(agentApprovalTypedData(intent)), digest, expiresAt: intent.consentExpiresAt } }; }
    catch { return value; }
  }
  if (path.endsWith("/returns") && body.consent) {
    const consent = body.consent as { account: string; destination: string; amount: string; nonce: number; consentExpiresAt: number };
    return { ...value, masterAction: { kind: "usd_send", account: consent.account, typedData: json(usdSendTypedData(WALLET_NETWORKS.testnet, consent.destination, consent.amount, consent.nonce)), digest, expiresAt: consent.consentExpiresAt } };
  }
  return value;
}
