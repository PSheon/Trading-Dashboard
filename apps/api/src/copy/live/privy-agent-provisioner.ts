import { createHash, createPublicKey } from "node:crypto";
import { PrivyClient } from "@privy-io/node";
import type { PolicyRuleRequestBody } from "@privy-io/node/resources";
import { z } from "zod";
import type { HyperliquidNetwork } from "@trading-dashboard/shared/contracts";

export interface AgentProviderConfig {
  appId?: string; appSecret?: string; workerQuorumId?: string; authorizationPublicKey?: string;
  /** The deployment's network: the phantom agent's `source` ("a" on mainnet,
   * "b" on testnet) and the policy's name. */
  network: HyperliquidNetwork;
}
export interface AgentPolicyInput { userId: string; expiresAt: number }
export interface AgentPolicyCreateInput extends AgentPolicyInput { attemptId: string; requestExpiry: number }
export interface AgentPolicyVerificationInput extends AgentPolicyInput { policyId: string }
export interface AgentWalletInput extends AgentPolicyVerificationInput { externalId: string }
export interface VerifiedAgentPolicy { id: string; ownerQuorumId: string; fingerprint: string }
export interface ProvisionedUserAgentWallet {
  id: string; address: string; externalId: string; ownerQuorumId: string; policyId: string; workerQuorumId: string;
}
export interface UserAgentProvisioner {
  readonly available: boolean;
  readonly configuredWorkerQuorumId: string | null;
  createPolicy(input: AgentPolicyCreateInput): Promise<{ id: string }>;
  verifyPolicy(input: AgentPolicyVerificationInput): Promise<VerifiedAgentPolicy>;
  createWallet(input: AgentWalletInput): Promise<void>;
  findOwned(input: AgentWalletInput): Promise<ProvisionedUserAgentWallet | null>;
  verifyWorkerQuorum(): Promise<void>;
}
export const USER_AGENT_PROVISIONER = Symbol("USER_AGENT_PROVISIONER");
export class AgentProvisioningConflict extends Error { constructor() { super("agent_provider_conflict"); } }
export class AgentProvisioningVerificationPending extends Error { constructor() { super("agent_verification_pending"); } }
export class AgentProviderUnavailable extends Error { constructor() { super("agent_provider_unavailable"); } }
export class AgentProvisioningInputError extends Error { constructor() { super("agent_invalid_input"); } }

/** Testnet's name is unchanged, so the policies already created still verify. */
const policyNames = { testnet: "Copy testnet agent", mainnet: "Copy mainnet agent" } as const satisfies Record<HyperliquidNetwork, string>;
/** Hyperliquid's phantom-agent `source` for L1 actions on each network. */
export const PHANTOM_AGENT_SOURCE = { mainnet: "a", testnet: "b" } as const satisfies Record<HyperliquidNetwork, string>;
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const providerId = z.string().regex(idPattern);
const quorumSchema = z.object({
  id: providerId, authorization_threshold: z.number().int().nullable(),
  authorization_keys: z.array(z.object({ public_key: z.string() })).max(100),
  user_ids: z.array(z.string()).max(100).nullable(), key_quorum_ids: z.array(z.string()).max(100).optional(),
});
const walletSchema = z.object({
  id: providerId, address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), chain_type: z.literal("ethereum"),
  external_id: z.string(), owner_id: providerId,
  exported_at: z.null(), imported_at: z.null(), archived_at: z.null().optional(),
  authorization_threshold: z.literal(1).optional(),
  policy_ids: z.array(providerId).length(1),
  additional_signers: z.array(z.object({ signer_id: providerId, override_policy_ids: z.array(providerId).length(1) }).strict()).length(1),
  automations: z.array(z.unknown()).length(0).optional(), custody: z.null().optional(),
});
const policySchema = z.object({
  id: providerId, name: z.string(), version: z.literal("1.0"), chain_type: z.literal("ethereum"),
  created_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  owner_id: providerId,
  rules: z.array(z.object({
    id: providerId, name: z.string(), method: z.string(), action: z.string(), conditions: z.array(z.unknown()).max(20),
  }).strict()).length(3),
}).strict();

function parseEvidence<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AgentProvisioningConflict();
  return result.data;
}

/** JSON object key order is irrelevant; array order (including type fields) remains exact. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function publicKeyIdentity(value: string): string {
  const encoded = value.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("invalid_key");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("invalid_key");
  const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
      !key.export({ format: "der", type: "spki" }).equals(bytes)) throw new Error("invalid_key");
  return encoded;
}

function policyRules(network: HyperliquidNetwork, expiresAt: number): PolicyRuleRequestBody[] {
  // This restricts the schema/network/time, not the order hidden by connectionId.
  // Match PrivyOrderSigner's complete emitted types; a second broad ALLOW would bypass this rule.
  return [{
    name: `Allow ${network} phantom agent until consent expiry`, method: "eth_signTypedData_v4", action: "ALLOW",
    conditions: [
      { field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: "1337" },
      { field_source: "ethereum_typed_data_domain", field: "verifyingContract", operator: "eq", value: "0x0000000000000000000000000000000000000000" },
      { field_source: "ethereum_typed_data_message", field: "source", operator: "eq", value: PHANTOM_AGENT_SOURCE[network], typed_data: {
        primary_type: "Agent", types: {
          EIP712Domain: [
            { name: "name", type: "string" }, { name: "version", type: "string" },
            { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
          ],
          Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }],
        },
      } },
      { field_source: "system", field: "current_unix_timestamp", operator: "lt", value: String(Math.floor(expiresAt / 1000)) },
    ],
  }, { name: "Deny key export", method: "exportPrivateKey", action: "DENY", conditions: [] },
  { name: "Deny seed export", method: "exportSeedPhrase", action: "DENY", conditions: [] }];
}

/** User-owned agent only. Master approval, consent and durable remote-operation recovery
 * belong to the lifecycle service. This adapter never signs or holds user/worker keys. */
export class PrivyUserAgentProvisioner implements UserAgentProvisioner {
  private readonly client: PrivyClient | null;
  private readonly config: Readonly<AgentProviderConfig>;
  private readonly workerKey: string | null;

  constructor(config: AgentProviderConfig) {
    this.config = { ...config };
    let key: string | null = null;
    try { if (config.authorizationPublicKey) key = publicKeyIdentity(config.authorizationPublicKey); } catch { /* fail closed */ }
    this.workerKey = key;
    this.client = config.appId?.trim() && config.appSecret?.trim() && config.workerQuorumId && idPattern.test(config.workerQuorumId) && key
      ? this.newClient() : null;
  }
  private newClient(requestExpiry?: number): PrivyClient {
    return new PrivyClient({ appId: this.config.appId!, appSecret: this.config.appSecret!, timeout: 10_000, maxRetries: 0, logLevel: "off",
      ...(requestExpiry === undefined ? {} : { defaultHeaders: { "privy-request-expiry": String(requestExpiry) } }),
    });
  }
  get available(): boolean { return this.client !== null; }
  get configuredWorkerQuorumId(): string | null { return this.available ? this.config.workerQuorumId! : null; }
  private requireClient(): PrivyClient {
    if (!this.client) throw new AgentProviderUnavailable();
    return this.client;
  }
  private assertInput(input: AgentPolicyInput): void {
    if (typeof input.userId !== "string" || !/^did:privy:[a-zA-Z0-9_-]{1,128}$/.test(input.userId) ||
        !Number.isSafeInteger(input.expiresAt) || Math.floor(input.expiresAt / 1000) <= Math.floor(Date.now() / 1000)) {
      throw new AgentProvisioningInputError();
    }
  }
  private assertId(value: string, max = 128): void {
    if (typeof value !== "string" || !idPattern.test(value) || value.length > max) throw new AgentProvisioningInputError();
  }
  private async providerRequest<T>(operation: () => PromiseLike<T>): Promise<T> {
    try { return await operation(); } catch { throw new AgentProviderUnavailable(); }
  }
  private async verifyUserQuorum(ownerId: string, userId: string): Promise<void> {
    const client = this.requireClient();
    const quorum = parseEvidence(quorumSchema, await this.providerRequest(() => client.keyQuorums().get(ownerId)));
    if (quorum.id !== ownerId || quorum.authorization_threshold !== 1 || quorum.authorization_keys.length !== 0 ||
        quorum.user_ids?.length !== 1 || quorum.user_ids[0] !== userId || quorum.key_quorum_ids?.length) throw new AgentProvisioningConflict();
  }

  async verifyWorkerQuorum(): Promise<void> {
    const client = this.requireClient();
    const id = this.config.workerQuorumId!;
    const quorum = parseEvidence(quorumSchema, await this.providerRequest(() => client.keyQuorums().get(id)));
    if (quorum.id !== id || quorum.authorization_threshold !== 1 || quorum.authorization_keys.length !== 1 ||
        quorum.user_ids?.length || quorum.key_quorum_ids?.length) throw new AgentProvisioningConflict();
    let actualKey: string;
    try { actualKey = publicKeyIdentity(quorum.authorization_keys[0].public_key); } catch { throw new AgentProvisioningConflict(); }
    if (actualKey !== this.workerKey) throw new AgentProvisioningConflict();
  }

  async createPolicy(input: AgentPolicyCreateInput): Promise<{ id: string }> {
    this.requireClient();
    const args = { ...input };
    this.assertInput(args); this.assertId(args.attemptId);
    if (!Number.isSafeInteger(args.requestExpiry) || args.requestExpiry <= Date.now() || args.requestExpiry > args.expiresAt) throw new AgentProvisioningInputError();
    // SDK create does not accept a per-request expiry. Set it on a dedicated client;
    // the persisted deadline is a header and never changes the idempotent body.
    const response = await this.providerRequest(() => this.newClient(args.requestExpiry).policies().create({
      version: "1.0", name: policyNames[this.config.network], chain_type: "ethereum", owner: { user_id: args.userId },
      rules: policyRules(this.config.network, args.expiresAt), idempotency_key: args.attemptId,
    }));
    return parseEvidence(z.object({ id: providerId }), response);
  }

  async verifyPolicy(input: AgentPolicyVerificationInput): Promise<VerifiedAgentPolicy> {
    const client = this.requireClient();
    const args = { ...input };
    this.assertInput(args); this.assertId(args.policyId);
    const policy = parseEvidence(policySchema, await this.providerRequest(() => client.policies().get(args.policyId)));
    const rules = policy.rules.map(({ id: _id, ...rule }) => rule);
    if (policy.id !== args.policyId || policy.name !== policyNames[this.config.network] || canonical(rules) !== canonical(policyRules(this.config.network, args.expiresAt))) throw new AgentProvisioningConflict();
    await this.verifyUserQuorum(policy.owner_id, args.userId);
    this.assertInput(args);
    const fingerprint = createHash("sha256").update(canonical({
      id: policy.id, ownerQuorumId: policy.owner_id, name: policy.name, version: policy.version, chain_type: policy.chain_type, rules,
    })).digest("hex");
    return { id: policy.id, ownerQuorumId: policy.owner_id, fingerprint };
  }

  async createWallet(input: AgentWalletInput): Promise<void> {
    const client = this.requireClient();
    const args = { ...input };
    this.assertInput(args); this.assertId(args.policyId); this.assertId(args.externalId, 64);
    await this.verifyWorkerQuorum();
    await this.verifyPolicy(args);
    this.assertInput(args);
    await this.providerRequest(() => client.wallets().create({
      chain_type: "ethereum", owner: { user_id: args.userId }, policy_ids: [args.policyId],
      additional_signers: [{ signer_id: this.config.workerQuorumId!, override_policy_ids: [args.policyId] }],
      external_id: args.externalId, idempotency_key: args.externalId, display_name: policyNames[this.config.network],
    }));
  }

  async findOwned(input: AgentWalletInput): Promise<ProvisionedUserAgentWallet | null> {
    const client = this.requireClient();
    const args = { ...input };
    this.assertInput(args); this.assertId(args.policyId); this.assertId(args.externalId, 64);
    let response: unknown;
    try { response = await client.wallets().get(`ext_wal_${args.externalId}`); }
    catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 404) return null;
      throw new AgentProviderUnavailable();
    }
    const wallet = parseEvidence(walletSchema, response);
    const listing = await this.providerRequest(() => client.wallets().list({ user_id: args.userId, external_id: args.externalId, chain_type: "ethereum" }));
    const listed = parseEvidence(z.object({ data: z.array(z.unknown()).max(1000), next_cursor: z.string().nullable().optional() }), listing);
    // The entire provider-filtered result must corroborate the immutable lookup.
    // Discarding rows by desired ID would hide competing identities for the same external ID.
    if (listed.data.length > 1) throw new AgentProvisioningConflict();
    if (listed.data.length === 0) throw new AgentProvisioningVerificationPending();
    const corroborated = parseEvidence(walletSchema, listed.data[0]);
    if (corroborated.id !== wallet.id) throw new AgentProvisioningConflict();
    for (const item of [wallet, corroborated]) {
      if (item.external_id !== args.externalId || item.owner_id !== wallet.owner_id || item.address.toLowerCase() !== wallet.address.toLowerCase() ||
          item.policy_ids[0] !== args.policyId || item.additional_signers[0].signer_id !== this.config.workerQuorumId ||
          item.additional_signers[0].override_policy_ids[0] !== args.policyId) throw new AgentProvisioningConflict();
    }
    // The SDK normalizes a null/missing cursor to "". Any nonempty continuation
    // leaves uniqueness unresolved; do not traverse unbounded pages or return a grant.
    if (listed.next_cursor) throw new AgentProvisioningVerificationPending();
    await this.verifyUserQuorum(wallet.owner_id, args.userId);
    await this.verifyWorkerQuorum();
    await this.verifyPolicy(args);
    this.assertInput(args);
    return { id: wallet.id, address: wallet.address.toLowerCase(), externalId: args.externalId,
      ownerQuorumId: wallet.owner_id, policyId: args.policyId, workerQuorumId: this.config.workerQuorumId!,
    };
  }
}
