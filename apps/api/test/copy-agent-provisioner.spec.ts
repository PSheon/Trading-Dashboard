import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyQuorum, Policy, PolicyRuleRequestBody, Wallet } from "@privy-io/node/resources";
import {
  AgentProviderUnavailable, AgentProvisioningConflict, AgentProvisioningInputError,
  AgentProvisioningVerificationPending, PrivyUserAgentProvisioner,
} from "../src/copy/live/privy-agent-provisioner.js";

// Only HTTP is replaced: request bodies/headers/errors are produced by the real installed SDK.
const userId = "did:privy:agent-owner";
const workerQuorumId = "worker-quorum";
const externalId = "copy_agent_0123456789abcdef";
const policyId = "policy-testnet";
const ownerQuorumId = "user-owner-quorum";
const walletId = "agent-wallet";
const agentAddress = `0x${"aB".repeat(20)}`;
const now = 1_800_000_000_000;
const expiresAt = now + 60_099;
const requestExpiry = now + 30_000;
const authorizationPublicKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
const anotherPublicKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
const config = { appId: "test-app", appSecret: "test-secret", workerQuorumId, authorizationPublicKey };
const policyArgs = { policyId, userId, expiresAt };
const walletArgs = { ...policyArgs, externalId };

function expectedRules(): PolicyRuleRequestBody[] {
  return [{
    name: "Allow testnet phantom agent until consent expiry", method: "eth_signTypedData_v4", action: "ALLOW",
    conditions: [
      { field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: "1337" },
      { field_source: "ethereum_typed_data_domain", field: "verifyingContract", operator: "eq", value: "0x0000000000000000000000000000000000000000" },
      { field_source: "ethereum_typed_data_message", field: "source", operator: "eq", value: "b", typed_data: {
        primary_type: "Agent", types: {
          EIP712Domain: [
            { name: "name", type: "string" }, { name: "version", type: "string" },
            { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
          ],
          Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }],
        },
      } },
      { field_source: "system", field: "current_unix_timestamp", operator: "lt", value: "1800000060" },
    ],
  }, { name: "Deny key export", method: "exportPrivateKey", action: "DENY", conditions: [] },
  { name: "Deny seed export", method: "exportSeedPhrase", action: "DENY", conditions: [] }];
}
function policy(overrides: Partial<Policy> = {}): Policy {
  return { id: policyId, name: "Copy testnet agent", chain_type: "ethereum", owner_id: ownerQuorumId,
    version: "1.0", created_at: now, rules: expectedRules().map((rule, index) => ({ ...rule, id: `rule-${index}` })), ...overrides };
}
function wallet(overrides: Partial<Wallet> = {}): Wallet {
  return { id: walletId, address: agentAddress, chain_type: "ethereum", external_id: externalId,
    owner_id: ownerQuorumId, additional_signers: [{ signer_id: workerQuorumId, override_policy_ids: [policyId] }],
    policy_ids: [policyId], created_at: now, exported_at: null, imported_at: null, archived_at: null, ...overrides };
}
function userQuorum(overrides: Partial<KeyQuorum> = {}): KeyQuorum {
  return { id: ownerQuorumId, user_ids: [userId], authorization_keys: [], authorization_threshold: 1, display_name: null, ...overrides };
}
function workerQuorum(overrides: Partial<KeyQuorum> = {}): KeyQuorum {
  return { id: workerQuorumId, user_ids: null, authorization_keys: [{ public_key: authorizationPublicKey, display_name: null }],
    authorization_threshold: 1, display_name: null, ...overrides };
}
let currentPolicy: Policy;
let directWallet: Wallet;
let listedWallets: Wallet[];
let listingCursor: string | null;
let currentUserQuorum: KeyQuorum;
let currentWorkerQuorum: KeyQuorum;
let failure: { path: string; status: number; body?: object } | undefined;
let transportFailure: string | undefined;
let stalledPath: string | undefined;
const requests: { path: string; method: string; body: unknown; headers: Headers }[] = [];
let onRequest: ((path: string) => void) | undefined;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  currentPolicy = policy(); directWallet = wallet(); listedWallets = [wallet()]; listingCursor = null;
  currentUserQuorum = userQuorum(); currentWorkerQuorum = workerQuorum();
  requests.length = 0; failure = undefined; transportFailure = undefined; stalledPath = undefined; onRequest = undefined;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    requests.push({ path: url.pathname + url.search, method, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (stalledPath === url.pathname) await new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    if (transportFailure === url.pathname) throw new Error("sensitive provider transport details");
    onRequest?.(url.pathname);
    if (failure?.path === url.pathname) return Response.json(failure.body ?? { error: "sensitive provider details" }, { status: failure.status });
    if (url.pathname === "/v1/policies" && method === "POST") return Response.json(currentPolicy);
    if (url.pathname === `/v1/policies/${policyId}`) return Response.json(currentPolicy);
    if (url.pathname === `/v1/key_quorums/${ownerQuorumId}`) return Response.json(currentUserQuorum);
    if (url.pathname === `/v1/key_quorums/${workerQuorumId}`) return Response.json(currentWorkerQuorum);
    if (url.pathname === `/v1/wallets/ext_wal_${externalId}`) return Response.json(directWallet);
    if (url.pathname === "/v1/wallets" && method === "GET") return Response.json({ data: listedWallets, next_cursor: listingCursor });
    if (url.pathname === "/v1/wallets" && method === "POST") return Response.json(directWallet);
    throw new Error(`Unexpected SDK request path ${url.pathname}`);
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Privy user-owned testnet agent provider", () => {
  it.each(["appId", "appSecret", "workerQuorumId", "authorizationPublicKey"] as const)("disables provisioning when %s is absent", async (field) => {
    const provider = new PrivyUserAgentProvisioner({ ...config, [field]: "" });
    expect(provider.available).toBe(false);
    expect(provider.configuredWorkerQuorumId).toBeNull();
    await expect(provider.createWallet(walletArgs)).rejects.toBeInstanceOf(AgentProviderUnavailable);
    await expect(provider.findOwned(walletArgs)).rejects.toBeInstanceOf(AgentProviderUnavailable);
    await expect(provider.createPolicy({ userId, attemptId: "attempt", expiresAt, requestExpiry })).rejects.toBeInstanceOf(AgentProviderUnavailable);
    await expect(provider.verifyPolicy(policyArgs)).rejects.toBeInstanceOf(AgentProviderUnavailable);
    await expect(provider.verifyWorkerQuorum()).rejects.toBeInstanceOf(AgentProviderUnavailable);
    expect(requests).toHaveLength(0);
  });

  it.each(["not-a-key", generateKeyPairSync("ec", { namedCurve: "secp256k1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64")])("rejects a non-P256 configured key", async (key) => {
    const provider = new PrivyUserAgentProvisioner({ ...config, authorizationPublicKey: key });
    expect(provider.available).toBe(false);
    await expect(provider.verifyWorkerQuorum()).rejects.toBeInstanceOf(AgentProviderUnavailable);
    expect(requests).toHaveLength(0);
  });

  it("creates an immutable user-owned policy with testnet schema, expiry and export denials", async () => {
    const provider = new PrivyUserAgentProvisioner(config);
    expect(provider.available).toBe(true);
    expect(provider.configuredWorkerQuorumId).toBe(workerQuorumId);
    await expect(provider.createPolicy({ userId, attemptId: "policy-attempt-1", expiresAt, requestExpiry })).resolves.toEqual({ id: policyId });
    const post = requests.find((request) => request.method === "POST")!;
    expect(post.path).toBe("/v1/policies");
    expect(post.body).toEqual({ version: "1.0", name: "Copy testnet agent", chain_type: "ethereum", owner: { user_id: userId }, rules: expectedRules() });
    expect(post.headers.get("privy-idempotency-key")).toBe("policy-attempt-1");
    expect(post.headers.get("privy-request-expiry")).toBe(String(requestExpiry));
    expect(post.headers.has("privy-authorization-signature")).toBe(false);
  });

  it("keeps policy body and request expiry immutable for an explicit retry", async () => {
    const provider = new PrivyUserAgentProvisioner(config);
    const input = { userId, attemptId: "policy-attempt-1", expiresAt, requestExpiry };
    await provider.createPolicy(input);
    vi.mocked(Date.now).mockReturnValue(now + 1_000);
    await provider.createPolicy(input);
    const posts = requests.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toEqual(posts[0].body);
    expect(posts[1].headers.get("privy-idempotency-key")).toBe(posts[0].headers.get("privy-idempotency-key"));
    expect(posts[1].headers.get("privy-request-expiry")).toBe(String(requestExpiry));
  });

  it("does not retry an ambiguous policy POST or expose provider error details", async () => {
    failure = { path: "/v1/policies", status: 500 };
    const result = new PrivyUserAgentProvisioner(config).createPolicy({ userId, attemptId: "policy-attempt-1", expiresAt, requestExpiry });
    await expect(result).rejects.toBeInstanceOf(AgentProviderUnavailable);
    await expect(result).rejects.toThrow("agent_provider_unavailable");
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it.each([now, now - 1, Number.NaN, Number.POSITIVE_INFINITY, now + 0.5])("refuses invalid/expired consent timestamp %s before policy POST", async (invalid) => {
    await expect(new PrivyUserAgentProvisioner(config).createPolicy({ userId, attemptId: "attempt", expiresAt: invalid, requestExpiry })).rejects.toBeInstanceOf(AgentProvisioningInputError);
    expect(requests).toHaveLength(0);
  });

  it.each([now, expiresAt + 1, Number.NaN])("refuses invalid request deadline %s", async (invalid) => {
    await expect(new PrivyUserAgentProvisioner(config).createPolicy({ userId, attemptId: "attempt", expiresAt, requestExpiry: invalid })).rejects.toBeInstanceOf(AgentProvisioningInputError);
    expect(requests).toHaveLength(0);
  });

  it("refuses consent shorter than its provider expiry second", async () => {
    await expect(new PrivyUserAgentProvisioner(config).createPolicy({ userId, attemptId: "attempt", expiresAt: now + 999, requestExpiry: now + 500 })).rejects.toBeInstanceOf(AgentProvisioningInputError);
    expect(requests).toHaveLength(0);
  });

  it("verifies exact policy rules and sole-user ownership and returns a stable SHA256 fingerprint", async () => {
    const provider = new PrivyUserAgentProvisioner(config);
    const first = await provider.verifyPolicy(policyArgs);
    expect(first).toMatchObject({ id: policyId, ownerQuorumId });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    currentPolicy.rules.forEach((rule, index) => { rule.id = `new-provider-rule-${index}`; });
    expect(await provider.verifyPolicy(policyArgs)).toEqual(first);
  });

  const policyTampering: { name: string; mutate: (value: Policy) => void }[] = [
    { name: "wrong policy ID", mutate: (value) => { value.id = "foreign-policy"; } },
    { name: "ownerless policy", mutate: (value) => { value.owner_id = null; } },
    { name: "different chain", mutate: (value) => { value.chain_type = "solana"; } },
    { name: "zero expiry", mutate: (value) => { value.rules[0].conditions[3].value = "0"; } },
    { name: "empty rules", mutate: (value) => { value.rules = []; } },
    { name: "extra default allowance field", mutate: (value) => { Object.assign(value, { default_action: "ALLOW" }); } },
    { name: "extra condition field", mutate: (value) => { Object.assign(value.rules[0].conditions[2], { fallback: "ALLOW" }); } },
    { name: "extra rule field", mutate: (value) => { Object.assign(value.rules[0], { fallback: "ALLOW" }); } },
    { name: "wildcard allowance", mutate: (value) => { value.rules.push({ id: "bypass", name: "Allow everything", method: "*", action: "ALLOW", conditions: [] }); } },
    { name: "domain-only bypass rule", mutate: (value) => { value.rules.push({ ...value.rules[0], id: "bypass", conditions: value.rules[0].conditions.slice(0, 2) }); } },
    { name: "wrong testnet source", mutate: (value) => { value.rules[0].conditions[2].value = "a"; } },
    { name: "wrong chain ID", mutate: (value) => { value.rules[0].conditions[0].value = "421614"; } },
    { name: "missing expiry", mutate: (value) => { value.rules[0].conditions.pop(); } },
    { name: "longer expiry", mutate: (value) => { value.rules[0].conditions[3].value = "1800000061"; } },
    { name: "expiry expressed in milliseconds", mutate: (value) => { value.rules[0].conditions[3].value = String(expiresAt); } },
    { name: "export allowed", mutate: (value) => { value.rules[1].action = "ALLOW"; } },
    { name: "missing domain type", mutate: (value) => { const condition = value.rules[0].conditions[2]; if (condition.field_source === "ethereum_typed_data_message") delete condition.typed_data.types.EIP712Domain; } },
    { name: "extra typed-data type", mutate: (value) => { const condition = value.rules[0].conditions[2]; if (condition.field_source === "ethereum_typed_data_message") condition.typed_data.types.Order = [{ name: "size", type: "uint256" }]; } },
    { name: "reordered Agent fields", mutate: (value) => { const condition = value.rules[0].conditions[2]; if (condition.field_source === "ethereum_typed_data_message") condition.typed_data.types.Agent.reverse(); } },
    { name: "different primary type", mutate: (value) => { const condition = value.rules[0].conditions[2]; if (condition.field_source === "ethereum_typed_data_message") condition.typed_data.primary_type = "ApproveAgent"; } },
  ];
  it.each(policyTampering)("refuses policy with $name", async ({ mutate }) => {
    mutate(currentPolicy);
    await expect(new PrivyUserAgentProvisioner(config).verifyPolicy(policyArgs)).rejects.toBeInstanceOf(AgentProvisioningConflict);
  });

  const userQuorumTampering: Partial<KeyQuorum>[] = [
    { id: "foreign-quorum" }, { user_ids: null }, { user_ids: [] }, { user_ids: ["did:privy:foreign"] },
    { user_ids: [userId, userId] }, { authorization_threshold: 2 }, { authorization_threshold: null },
    { authorization_keys: [{ public_key: authorizationPublicKey, display_name: null }] }, { key_quorum_ids: [workerQuorumId] },
  ];
  it.each(userQuorumTampering)("refuses non-sole-user policy ownership %j", async (overrides) => {
    currentUserQuorum = userQuorum(overrides);
    await expect(new PrivyUserAgentProvisioner(config).verifyPolicy(policyArgs)).rejects.toBeInstanceOf(AgentProvisioningConflict);
  });

  const workerQuorumTampering: Partial<KeyQuorum>[] = [
    { id: "foreign-quorum" }, { user_ids: [userId] }, { authorization_threshold: 0 }, { authorization_threshold: 2 },
    { authorization_keys: [] }, { authorization_keys: [{ public_key: anotherPublicKey, display_name: null }] },
    { authorization_keys: [{ public_key: "malformed", display_name: null }] },
    { authorization_keys: [{ public_key: authorizationPublicKey, display_name: null }, { public_key: authorizationPublicKey, display_name: null }] },
    { key_quorum_ids: ["foreign-quorum"] },
  ];
  it.each(workerQuorumTampering)("refuses configured worker-quorum substitution %j", async (overrides) => {
    currentWorkerQuorum = workerQuorum(overrides);
    await expect(new PrivyUserAgentProvisioner(config).verifyWorkerQuorum()).rejects.toBeInstanceOf(AgentProvisioningConflict);
    await expect(new PrivyUserAgentProvisioner(config).createWallet(walletArgs)).rejects.toBeInstanceOf(AgentProvisioningConflict);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("creates only a separately user-owned wallet with the configured policy/signer binding", async () => {
    const provider = new PrivyUserAgentProvisioner(config);
    await expect(provider.createWallet(walletArgs)).resolves.toBeUndefined();
    const post = requests.find((request) => request.method === "POST")!;
    expect(post.path).toBe("/v1/wallets");
    expect(post.body).toEqual({ chain_type: "ethereum", owner: { user_id: userId }, policy_ids: [policyId],
      additional_signers: [{ signer_id: workerQuorumId, override_policy_ids: [policyId] }],
      external_id: externalId, display_name: "Copy testnet agent" });
    expect(post.headers.get("privy-idempotency-key")).toBe(externalId);
  });

  it("refuses wallet creation if consent expires during provider ownership verification", async () => {
    onRequest = (path) => { if (path === `/v1/key_quorums/${ownerQuorumId}`) vi.mocked(Date.now).mockReturnValue(expiresAt); };
    await expect(new PrivyUserAgentProvisioner(config).createWallet(walletArgs)).rejects.toBeInstanceOf(AgentProvisioningInputError);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("does not POST a wallet when policy was relaxed to a domain-only allowance", async () => {
    currentPolicy.rules[0].conditions = currentPolicy.rules[0].conditions.slice(0, 2);
    await expect(new PrivyUserAgentProvisioner(config).createWallet(walletArgs)).rejects.toBeInstanceOf(AgentProvisioningConflict);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("does not verify a recovered wallet when the worker key changed at the provider", async () => {
    currentWorkerQuorum = workerQuorum({ authorization_keys: [{ public_key: anotherPublicKey, display_name: null }] });
    await expect(new PrivyUserAgentProvisioner(config).findOwned(walletArgs)).rejects.toBeInstanceOf(AgentProvisioningConflict);
  });

  it("recovers by immutable wallet external ID and corroborates provider identity", async () => {
    listedWallets = [wallet({ address: agentAddress.toLowerCase() })];
    await expect(new PrivyUserAgentProvisioner(config).findOwned(walletArgs)).resolves.toEqual({
      id: walletId, address: agentAddress.toLowerCase(), externalId, ownerQuorumId, policyId, workerQuorumId,
    });
    const listing = requests.find((request) => request.path.startsWith("/v1/wallets?"))!;
    const params = new URL(listing.path, "https://example.invalid").searchParams;
    expect(Object.fromEntries(params)).toEqual({ user_id: userId, external_id: externalId, chain_type: "ethereum" });
    expect(requests.filter((request) => request.method !== "GET")).toHaveLength(0);
  });

  it("returns absence only for direct lookup 404", async () => {
    failure = { path: `/v1/wallets/ext_wal_${externalId}`, status: 404 };
    await expect(new PrivyUserAgentProvisioner(config).findOwned(walletArgs)).resolves.toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("keeps missing provider user-filter indexing pending without recreating the wallet", async () => {
    listedWallets = [];
    const provider = new PrivyUserAgentProvisioner(config);
    await expect(provider.findOwned(walletArgs)).rejects.toBeInstanceOf(AgentProvisioningVerificationPending);
    listedWallets = [wallet()];
    await expect(provider.findOwned(walletArgs)).resolves.toMatchObject({ id: walletId });
    expect(requests.filter((request) => request.method !== "GET")).toHaveLength(0);
  });

  it("refuses duplicate matching wallet identities from the user filter", async () => {
    listedWallets = [wallet(), wallet()];
    await expect(new PrivyUserAgentProvisioner(config).findOwned(walletArgs)).rejects.toBeInstanceOf(AgentProvisioningConflict);
  });

  it("refuses the desired wallet plus a distinct wallet claiming the immutable external ID", async () => {
    listedWallets = [wallet(), wallet({ id: "competing-wallet", address: `0x${"12".repeat(20)}` })];
    await expect(new PrivyUserAgentProvisioner(config).findOwned(walletArgs)).rejects.toBeInstanceOf(AgentProvisioningConflict);
    expect(requests.filter((request) => request.method !== "GET")).toHaveLength(0);
  });

  it("classifies a competing external-ID wallet as a conflict, not empty-index lag", async () => {
    listedWallets = [wallet({ id: "competing-wallet" })];
    await expect(new PrivyUserAgentProvisioner(config).findOwned(walletArgs)).rejects.toBeInstanceOf(AgentProvisioningConflict);
  });

  it.each([
    wallet({ id: "wrong-filter-wallet", external_id: "foreign-external-id" }),
    { id: "malformed-extra-wallet" } as Wallet,
  ])("refuses contradictory or malformed extra filtered-list rows", async (extra) => {
    listedWallets = [wallet(), extra];
    await expect(new PrivyUserAgentProvisioner(config).findOwned(walletArgs)).rejects.toBeInstanceOf(AgentProvisioningConflict);
  });

  it("keeps a matching wallet on an incomplete page pending until uniqueness is complete", async () => {
    listingCursor = "more-wallets";
    const provider = new PrivyUserAgentProvisioner(config);
    await expect(provider.findOwned(walletArgs)).rejects.toBeInstanceOf(AgentProvisioningVerificationPending);
    expect(requests.filter((request) => request.method !== "GET")).toHaveLength(0);
    listingCursor = null;
    await expect(provider.findOwned(walletArgs)).resolves.toMatchObject({ id: walletId });
  });

  const walletTampering: { name: string; overrides: Partial<Wallet> }[] = [
    { name: "missing external ID", overrides: { external_id: undefined } },
    { name: "different external ID", overrides: { external_id: "different" } },
    { name: "ownerless wallet", overrides: { owner_id: null } },
    { name: "foreign owner quorum", overrides: { owner_id: "foreign-owner" } },
    { name: "malformed address", overrides: { address: "0x1234" } },
    { name: "foreign address", overrides: { address: `0x${"12".repeat(20)}` } },
    { name: "archived wallet", overrides: { archived_at: 0 } },
    { name: "exported key", overrides: { exported_at: 0 } },
    { name: "imported key", overrides: { imported_at: 0 } },
    { name: "zero wallet threshold", overrides: { authorization_threshold: 0 } },
    { name: "wrong chain", overrides: { chain_type: "solana" } },
    { name: "missing wallet policy", overrides: { policy_ids: [] } },
    { name: "multiple policies", overrides: { policy_ids: [policyId, "foreign-policy"] } },
    { name: "missing worker", overrides: { additional_signers: [] } },
    { name: "different worker", overrides: { additional_signers: [{ signer_id: "foreign-worker", override_policy_ids: [policyId] }] } },
    { name: "policyless worker", overrides: { additional_signers: [{ signer_id: workerQuorumId, override_policy_ids: [] }] } },
    { name: "missing override policy", overrides: { additional_signers: [{ signer_id: workerQuorumId }] } },
    { name: "extra signer", overrides: { additional_signers: [{ signer_id: workerQuorumId, override_policy_ids: [policyId] }, { signer_id: "foreign-signer" }] } },
    { name: "enabled automation", overrides: { automations: [{ id: "automation", enabled: true }] } },
    { name: "disabled automation", overrides: { automations: [{ id: "automation", enabled: false }] } },
    { name: "custodial wallet", overrides: { custody: { provider: "bridge", provider_user_id: "custodian" } } },
  ];
  describe.each(["direct", "listed"] as const)("%s wallet binding", (source) => {
    it.each(walletTampering)("refuses $name", async ({ overrides }) => {
      if (source === "direct") directWallet = wallet(overrides); else listedWallets = [wallet(overrides)];
      await expect(new PrivyUserAgentProvisioner(config).findOwned(walletArgs)).rejects.toBeInstanceOf(AgentProvisioningConflict);
    });
  });

  it("requires generated key metadata even when both endpoints omit it", async () => {
    delete (directWallet as Partial<Wallet>).exported_at;
    delete (listedWallets[0] as Partial<Wallet>).exported_at;
    await expect(new PrivyUserAgentProvisioner(config).findOwned(walletArgs)).rejects.toBeInstanceOf(AgentProvisioningConflict);
  });

  it("checks current policy again on a previously found wallet", async () => {
    const provider = new PrivyUserAgentProvisioner(config);
    await provider.findOwned(walletArgs);
    currentPolicy.rules[0].conditions[2].value = "a";
    await expect(provider.findOwned(walletArgs)).rejects.toBeInstanceOf(AgentProvisioningConflict);
  });

  it.each([401, 403, 429, 500])("does not mistake unavailable provider status %s for absence or expose payloads", async (status) => {
    failure = { path: `/v1/wallets/ext_wal_${externalId}`, status };
    await expect(new PrivyUserAgentProvisioner(config).findOwned(walletArgs)).rejects.toThrow("agent_provider_unavailable");
    expect(requests).toHaveLength(1);
  });

  it("sanitizes transport errors without retries", async () => {
    transportFailure = `/v1/wallets/ext_wal_${externalId}`;
    await expect(new PrivyUserAgentProvisioner(config).findOwned(walletArgs)).rejects.toThrow("agent_provider_unavailable");
    expect(requests).toHaveLength(1);
  });

  it("aborts a stalled provider read after ten seconds without retrying", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stalledPath = `/v1/wallets/ext_wal_${externalId}`;
    let settled = false;
    const result = new PrivyUserAgentProvisioner(config).findOwned(walletArgs);
    void result.catch(() => { settled = true; });
    const expectation = expect(result).rejects.toBeInstanceOf(AgentProviderUnavailable);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expectation;
    expect(requests).toHaveLength(1);
  });
});
