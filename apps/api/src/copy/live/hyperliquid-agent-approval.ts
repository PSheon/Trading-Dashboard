import { z } from "zod";
import { WALLET_NETWORKS } from "@trading-dashboard/shared/contracts";
import { readInfoJson } from "../../hyperliquid/response-validation.js";
import { address, LiveBoundaryError, type ExchangeApprovalEvidence, type ExchangeApprovalVerifier, type LiveNetwork, type WalletAuthorization } from "./wallet-authorization.js";

const ethereumAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const roleSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user") }), z.object({ role: z.literal("missing") }),
  z.object({ role: z.literal("vault") }),
  z.object({ role: z.literal("agent"), data: z.object({ user: ethereumAddress }) }),
  z.object({ role: z.literal("subAccount"), data: z.object({ master: ethereumAddress }) }),
]);
const agentsSchema = z.array(z.object({ address: ethereumAddress, name: z.string().max(256),
  validUntil: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() })).max(100);

/** Read-only, uncached exchange proof. Explicitly listed agents are supported.
 * An unnamed/default agent that is absent from
 * extraAgents is refused, rather than guessing its validity from userRole.
 * A listing is queried on the exact account and binds the signer to that
 * account. Ownership and supported account role remain activation/risk-gate
 * requirements; querying userRole redundantly does not add consent evidence.
 * Self signing separately requires a user role, never an agent/vault/subaccount. */
export class HyperliquidAgentApprovalVerifier implements ExchangeApprovalVerifier {
  private readonly endpoint: string;
  constructor(readonly network: LiveNetwork, private readonly acquire: (weight: number) => Promise<unknown>,
    private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {
    if (!["testnet", "mainnet"].includes(network)) throw new LiveBoundaryError("unsupported_exchange_network");
    this.endpoint = WALLET_NETWORKS[network].infoUrl;
  }

  async verify(grant: WalletAuthorization): Promise<ExchangeApprovalEvidence> {
    if (grant.network !== this.network) throw new LiveBoundaryError("exchange_approval_network_mismatch");
    const account = address(grant.accountAddress);
    const signer = address(grant.signerAddress);
    const checkedAt = this.now();
    try {
      let expiresAt: number | null = null;
      if (signer !== account) {
        const matches = agentsSchema.parse(await this.read({ type: "extraAgents", user: account })).filter((agent) => address(agent.address) === signer);
        if (matches.length !== 1) throw new LiveBoundaryError("exchange_agent_not_approved");
        expiresAt = matches[0].validUntil;
        if (expiresAt !== null && expiresAt <= this.now()) throw new LiveBoundaryError("exchange_agent_expired");
      } else if (roleSchema.parse(await this.read({ type: "userRole", user: account })).role !== "user") {
        throw new LiveBoundaryError("unsupported_execution_account_role");
      }
      // Timestamp the start of the observation: slow requests cannot turn old
      // role evidence into fresh proof merely by timestamping the last response.
      if (this.now() - checkedAt > 5_000) throw new LiveBoundaryError("exchange_approval_evidence_expired");
      return { network: this.network, accountAddress: account, signerAddress: signer, checkedAt, expiresAt };
    } catch (error) {
      if (error instanceof LiveBoundaryError) throw error;
      // Do not expose response payloads, SDK errors or remote error text.
      throw new LiveBoundaryError("exchange_approval_unavailable");
    }
  }

  private async read(body: { type: "userRole" | "extraAgents"; user: string }): Promise<unknown> {
    // Official weights: userRole 60, other info requests (extraAgents) 20.
    await this.acquire(body.type === "userRole" ? 60 : 20);
    const response = await this.fetcher(this.endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error("Approval evidence unavailable"); }
    return readInfoJson(response, "agent approval", 64 * 1024);
  }
}
