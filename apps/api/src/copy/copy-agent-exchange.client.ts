import { PrivyClient } from "@privy-io/node";
import { WALLET_NETWORKS, splitSignature } from "@trading-dashboard/shared/contracts";
import { z } from "zod";
import { readInfoJson } from "../hyperliquid/response-validation.js";
import { agentApprovalTypedData, type AgentConsentIntent } from "./copy-agent-consent.js";
import { LiveBoundaryError } from "./live/wallet-authorization.js";

export const AGENT_APPROVAL_CLIENT = Symbol("AGENT_APPROVAL_CLIENT");
export interface AgentApprovalClient {
  readonly available: boolean;
  acquire(): Promise<unknown>;
  signMaster(account: { walletId: string; address: string; ownerQuorumId: string }, intent: AgentConsentIntent, userJwt: string): Promise<string>;
  send(intent: AgentConsentIntent, signature: string): Promise<unknown>;
  observe(intent: AgentConsentIntent): Promise<{ checkedAt: number; validUntil: number } | null>;
}
const domainFields = [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }];
const agents = z.array(z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), name: z.string().max(256),
  validUntil: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable() })).max(100);

/** Fresh user authorization is used for one exact master approval. Neither the
 * JWT nor a reusable master authorization is persisted or passed to workers. */
export class PrivyAgentApprovalClient implements AgentApprovalClient {
  private readonly credentials: Readonly<{ appId: string; appSecret: string }> | null;
  constructor(config: { appId?: string; appSecret?: string }, private readonly budget: (weight: number) => Promise<unknown>,
    private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {
    this.credentials = config.appId && config.appSecret ? Object.freeze({ appId: config.appId, appSecret: config.appSecret }) : null;
  }
  get available() { return this.credentials !== null; }
  acquire() { return this.budget(1); }
  async signMaster(account: { walletId: string; address: string; ownerQuorumId: string }, intent: AgentConsentIntent, userJwt: string): Promise<string> {
    try {
      const data = agentApprovalTypedData(intent);
      if (!this.credentials || !userJwt || this.now() >= intent.consentExpiresAt || account.address.toLowerCase() !== intent.accountAddress.toLowerCase()) throw new Error();
      // The SDK caches exchanged user keys. Keep that cache scoped to this
      // single request instead of retaining reusable master authority.
      const client = new PrivyClient({ ...this.credentials, timeout: 10_000, maxRetries: 0, logLevel: "off" });
      const wallet = await client.wallets().get(account.walletId);
      if (wallet.id !== account.walletId || wallet.chain_type !== "ethereum" || wallet.address.toLowerCase() !== account.address.toLowerCase() ||
        wallet.owner_id !== account.ownerQuorumId || wallet.archived_at != null || this.now() >= intent.consentExpiresAt) throw new Error();
      const result = await client.wallets().ethereum().signTypedData(account.walletId, {
        address: account.address, authorization_context: { user_jwts: [userJwt] }, request_expiry: intent.consentExpiresAt,
        params: { typed_data: { domain: data.domain, types: { ...data.types, EIP712Domain: domainFields }, primary_type: data.primaryType, message: data.message } },
      });
      if (result.encoding !== "hex" || !/^0x[0-9a-fA-F]{130}$/.test(result.signature)) throw new Error();
      return result.signature;
    } catch { throw new LiveBoundaryError("agent_master_approval_unavailable"); }
  }
  async send(intent: AgentConsentIntent, signature: string): Promise<unknown> {
    const data = agentApprovalTypedData(intent);
    if (this.now() >= intent.consentExpiresAt) throw new LiveBoundaryError("agent_consent_expired");
    try {
      const response = await this.fetcher(WALLET_NETWORKS.testnet.exchangeUrl, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: { type: "approveAgent", signatureChainId: WALLET_NETWORKS.testnet.signatureChainId,
          ...data.message }, nonce: intent.nonce, signature: splitSignature(signature) }), redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(); }
      return await readInfoJson(response, "agent approval submission", 64 * 1024);
    } catch { throw new LiveBoundaryError("agent_approval_submission_unknown"); }
  }
  async observe(intent: AgentConsentIntent): Promise<{ checkedAt: number; validUntil: number } | null> {
    const data = agentApprovalTypedData(intent);
    const checkedAt = this.now();
    try {
      // A strategy master must be a user account. Agents/vaults/subaccounts are
      // not interchangeable with an explicitly owned, funded master account.
      const role = await this.read({ type: "userRole", user: intent.accountAddress }, 60);
      if (!role || typeof role !== "object" || !("role" in role) || role.role !== "user") throw new Error();
      const list = agents.parse(await this.read({ type: "extraAgents", user: intent.accountAddress }, 20));
      const matches = list.filter(a => a.address.toLowerCase() === data.message.agentAddress);
      if (this.now() < checkedAt || this.now() - checkedAt > 5_000) throw new Error();
      if (!matches.length) return null;
      if (matches.length !== 1 || (matches[0].name !== `copy${intent.strategyId}` && matches[0].name !== data.message.agentName) ||
        matches[0].validUntil !== intent.expiresAt || intent.expiresAt <= this.now()) throw new Error();
      return { checkedAt, validUntil: intent.expiresAt };
    } catch { throw new LiveBoundaryError("agent_approval_evidence_unavailable"); }
  }
  private async read(body: { type: "userRole" | "extraAgents"; user: string }, weight: number) {
    await this.budget(weight);
    const response = await this.fetcher(WALLET_NETWORKS.testnet.infoUrl, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(); }
    return readInfoJson(response, "agent approval evidence", 64 * 1024);
  }
}
