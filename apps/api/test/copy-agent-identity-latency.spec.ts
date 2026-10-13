import { generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { copyAgentSetups, copyExecutionAccounts, copyLiveSetups, copyStrategies, copyWalletAuthorizations } from "@trading-dashboard/shared/database";
import { CopyAgentRepository } from "../src/copy/copy-agent.repository.js";
import { CopyAgentService } from "../src/copy/copy-agent.service.js";
import { CopyWalletRepository } from "../src/copy/copy-wallet.repository.js";
import { CopyWalletService } from "../src/copy/copy-wallet.service.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { agentApprovalTypedData } from "../src/copy/copy-agent-consent.js";
import { PrivyUserAgentProvisioner } from "../src/copy/live/privy-agent-provisioner.js";
import { PrivyUserWalletProvisioner } from "../src/copy/live/privy-wallet-provisioner.js";
import type { AgentApprovalClient } from "../src/copy/copy-agent-exchange.client.js";
import { testConfig } from "./config-test-utils.js";
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from "./db-test-utils.js";

/**
 * Gate run 8 (2026-10-13 12:48–12:59, a phone hotspot): the agent's identity
 * proof is about a dozen Privy HTTPS calls. One after another they took more
 * than its 5 s, every pass, and the setup sat at agent_approval_pending
 * although Hyperliquid listed the agent. Here the real Privy SDKs and the real
 * wallet service run against a fake Privy HTTP endpoint that answers each
 * request after PRIVY_LATENCY_MS of the test's clock (which runs SCALE times
 * faster than the wall clock, so a 1.5 s call takes 150 ms of the test).
 */
const SCALE = 10, PRIVY_LATENCY_MS = 1_500;
const privyId = "did:privy:agent-owner";
const master = privateKeyToAccount(`0x${"02".repeat(32)}`);
const agent = privateKeyToAccount(`0x${"03".repeat(32)}`);
const workerKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
let db: TestDb; let uid: number; let strategyId: number; const accountId = "account-1";
let service: CopyAgentService; let exchange: AgentApprovalClient; let approved: boolean;
let privyRequests: { path: string; at: number }[]; let latencyMs: number; let policies: Map<string, unknown>; let agentWallets: Map<string, unknown>;

function wallet(externalId: string, address: string, signers: { signer_id: string; override_policy_ids: string[] }[], policyIds: string[]) {
  return { id: `wallet-${externalId}`, address, chain_type: "ethereum", external_id: externalId, owner_id: "user-quorum", additional_signers: signers,
    policy_ids: policyIds, created_at: 1, exported_at: null, imported_at: null, archived_at: null };
}
const masterWallet = () => ({ ...wallet("master-external", master.address, [], []), id: "master-wallet" });
const quorums: Record<string, unknown> = {
  "user-quorum": { id: "user-quorum", user_ids: [privyId], authorization_keys: [], authorization_threshold: 1, display_name: null },
  "worker-quorum": { id: "worker-quorum", user_ids: null, authorization_keys: [{ public_key: workerKey, display_name: null }], authorization_threshold: 1, display_name: null },
};
async function privy(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  privyRequests.push({ path: `${method} ${url.pathname}`, at: Date.now() });
  await new Promise(resolve => setTimeout(resolve, latencyMs / SCALE));
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  const path = url.pathname;
  if (path === "/v1/policies" && method === "POST") {
    const id = "user-policy";
    policies.set(id, { id, name: body.name, version: "1.0", chain_type: "ethereum", owner_id: "user-quorum", created_at: 1,
      rules: (body.rules as object[]).map((rule, index) => ({ ...rule, id: `rule-${index}` })) });
    return Response.json({ id });
  }
  if (path.startsWith("/v1/policies/")) return policies.has(path.slice(13)) ? Response.json(policies.get(path.slice(13))) : Response.json({}, { status: 404 });
  if (path.startsWith("/v1/key_quorums/")) return Response.json(quorums[path.slice(16)]);
  if (path === "/v1/wallets" && method === "POST") {
    const external = String(body.external_id);
    agentWallets.set(external, wallet(external, agent.address, [{ signer_id: "worker-quorum", override_policy_ids: body.policy_ids as string[] }], body.policy_ids as string[]));
    return Response.json(agentWallets.get(external));
  }
  if (path === "/v1/wallets" && method === "GET") {
    const external = url.searchParams.get("external_id")!;
    const found = external === "master-external" ? masterWallet() : agentWallets.get(external);
    return Response.json({ data: found ? [found] : [], next_cursor: null });
  }
  if (path.startsWith("/v1/wallets/ext_wal_")) {
    const external = path.slice(20);
    const found = external === "master-external" ? masterWallet() : agentWallets.get(external);
    return found ? Response.json(found) : Response.json({ error: "not found" }, { status: 404 });
  }
  throw new Error(`unexpected Privy request ${method} ${path}`);
}

beforeAll(() => { db = getTestDb(); });
beforeEach(async () => {
  await truncateAll(db);
  approved = false; privyRequests = []; latencyMs = PRIVY_LATENCY_MS; policies = new Map(); agentWallets = new Map();
  uid = (await insertUser(db, { privyUserId: privyId, embeddedWalletAddress: privateKeyToAccount(`0x${"01".repeat(32)}`).address.toLowerCase() })).id;
  strategyId = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: agent.address.toLowerCase(), allocated: "100", cash: "100", activatedAt: new Date() }).returning())[0].id;
  await db.insert(copyExecutionAccounts).values({ id: accountId, userId: uid, strategyId, network: "testnet", privyUserId: privyId,
    externalId: "master-external", state: "ready", address: master.address.toLowerCase(), privyWalletId: "master-wallet", ownerQuorumId: "user-quorum" });
  // The test's clock runs SCALE× the wall clock: a Privy call's 150 ms is its 1.5 s.
  const wall0 = performance.now(), clock0 = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock0 + Math.round((performance.now() - wall0) * SCALE));
  vi.stubGlobal("fetch", privy);
  const provider = new PrivyUserAgentProvisioner({ appId: "test-app", appSecret: "test-secret", workerQuorumId: "worker-quorum", authorizationPublicKey: workerKey, network: "testnet" });
  const walletProvider = new PrivyUserWalletProvisioner({ value: { auth: { appId: "test-app", appSecret: "test-secret" } } } as never);
  const wallets = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), testConfig(), walletProvider);
  exchange = { available: true, acquire: vi.fn(async () => undefined),
    send: vi.fn(async () => { approved = true; return { status: "ok", response: { type: "default" } }; }),
    observe: vi.fn(async (intent) => approved ? { checkedAt: Date.now(), validUntil: intent.expiresAt } : null) };
  service = new CopyAgentService(new CopyAgentRepository(db), new UnitOfWork(db), testConfig(), wallets, provider, exchange);
});
afterAll(closeTestDb);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function prepared() {
  const result = await service.prepare(uid, accountId, { idempotencyKey: "latency-1", validForDays: 7 });
  expect(result.state).toBe("ready");
  await db.insert(copyLiveSetups).values({ id: "setup-1", userId: uid, strategyId, kind: "start", idempotencyKey: "agent-latency-setup-0001", leaderAddress: `0x${"44".repeat(20)}`,
    sourceNetwork: "mainnet", budgetUsd: "100", settings: {} });
  await db.update(copyAgentSetups).set({ liveSetupId: "setup-1" }).where(eq(copyAgentSetups.id, result.id));
  return result;
}
const approve = (id: string) => service.submit(uid, id, { kind: "setup", consentDigest: "c".repeat(64),
  sign: async (_account, intent, assertFresh) => { assertFresh(); return master.signTypedData(agentApprovalTypedData(intent)); } });

describe("an agent's identity proof over a slow link to Privy (1.5 s a call)", () => {
  it("challenges, approves and records the agent: its Privy reads run together and stay inside the identity bound", async () => {
    const setup = await prepared();
    privyRequests = [];
    const proofStarted = Date.now();
    await service.challengeRow(uid, setup.id);
    const challengeMs = Date.now() - proofStarted;
    // The copy account (lookup, listing, owner quorum), the worker quorum, the
    // policy (and its owner quorum), the agent wallet (lookup, listing, and its
    // quorums and policy again): twelve Privy calls in one proof.
    expect(privyRequests).toHaveLength(12);
    const result = await approve(setup.id);
    expect(result.state).toBe("active");
    expect(exchange.send).toHaveBeenCalledTimes(1);
    expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(1);
    // One proof is about a dozen Privy calls; together they take about three
    // round trips, not twelve (18 s at 1.5 s each, before).
    expect(challengeMs).toBeLessThan(4 * PRIVY_LATENCY_MS + 2_000);
  }, 60_000);

  it("an expired identity proof says which reads took how long", async () => {
    const setup = await prepared();
    // Twelve times slower than the bound allows: no parallelism makes it pass.
    latencyMs = 10 * PRIVY_LATENCY_MS;
    const failure = await service.challengeRow(uid, setup.id).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ message: "agent_identity_evidence_expired" });
    const { spans, elapsedMs } = failure as { spans: { name: string; ms: number }[]; elapsedMs: number };
    expect(elapsedMs).toBeGreaterThan(30_000);
    expect(spans.map(span => span.name).sort()).toEqual(["db_current", "db_current_after", "privy_agent_wallet", "privy_master_account", "privy_policy", "privy_worker_quorum"]);
    expect(spans.find(span => span.name === "privy_agent_wallet")!.ms).toBeGreaterThan(2 * 10 * PRIVY_LATENCY_MS - 1);
  }, 60_000);
});
