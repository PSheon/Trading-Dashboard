import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { copyAgentOverviewSchema, copyAgentSetupSchema } from "@trading-dashboard/shared/contracts";
import { copyAgentSetups, copyExecutionAccounts, copyStrategies, copyWalletAuthorizations, users } from "@trading-dashboard/shared/database";
import { CopyAgentController } from "../src/copy/copy-agent.controller.js";
import { CopyAgentRepository } from "../src/copy/copy-agent.repository.js";
import { CopyAgentService } from "../src/copy/copy-agent.service.js";
import { CopyWalletService } from "../src/copy/copy-wallet.service.js";
import { AGENT_APPROVAL_CLIENT, type AgentApprovalClient } from "../src/copy/copy-agent-exchange.client.js";
import { USER_AGENT_PROVISIONER, type UserAgentProvisioner } from "../src/copy/live/privy-agent-provisioner.js";
import type { AuthService } from "../src/common/auth/auth.service.js";
import { createAuthedApp, stubPrivy } from "./auth-test-utils.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

// Real Nest auth, DTO pipes, controller, service, repository and PostgreSQL.
// Only remote provider/exchange boundaries are replaced; all signatures use
// disposable deterministic test keys and never leave the local test process.
const db = getTestDb(), owner = privateKeyToAccount(`0x${"01".repeat(32)}`), master = privateKeyToAccount(`0x${"02".repeat(32)}`), agent = privateKeyToAccount(`0x${"03".repeat(32)}`);
const serviceToken = "agent-routes-service-token-0123456789012345";
const privy = stubPrivy({ alice: { privyUserId: "did:privy:agent-route-alice" }, bob: { privyUserId: "did:privy:agent-route-bob" }, expired: { privyUserId: "did:privy:agent-route-alice", expiresAt: new Date(0) } });
let app: INestApplication, auth: AuthService, uid: number, strategyId: number;
let walletExists = false, exchangeApproved = false;
const accountId = "route-account", preparePath = `/me/copy/execution-wallets/${accountId}/agent`;
const wallets = { reconcile: vi.fn() };
const provider: UserAgentProvisioner = { available: true, configuredWorkerQuorumId: "worker-quorum",
  verifyWorkerQuorum: vi.fn(async () => undefined), createPolicy: vi.fn(async () => ({ id: "agent-policy" })),
  verifyPolicy: vi.fn(async () => ({ id: "agent-policy", ownerQuorumId: "user-quorum", fingerprint: "a".repeat(64) })),
  createWallet: vi.fn(async () => { walletExists = true; }),
  findOwned: vi.fn(async (input) => walletExists ? { id: "agent-provider-wallet", address: agent.address.toLowerCase(), externalId: input.externalId, ownerQuorumId: "user-quorum", policyId: "agent-policy", workerQuorumId: "worker-quorum" } : null),
};
const exchange: AgentApprovalClient = { available: true, acquire: vi.fn(async () => undefined),
  send: vi.fn(async () => { exchangeApproved = true; return { status: "ok", response: { type: "default" } }; }),
  observe: vi.fn(async (intent) => exchangeApproved ? { checkedAt: Date.now(), validUntil: intent.expiresAt } : null),
};
const get = (token = "alice") => request(app.getHttpServer()).get("/me/copy/agents").set("Authorization", `Bearer ${token}`);
const post = (path: string, body: object, token = "alice") => request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${token}`).send(body);
const setupPath = (id: string, action: string) => `/me/copy/agents/${id}/${action}`;
const fakeSignature = `0x${"00".repeat(64)}1b`;
function assertNoApproval() { expect(exchange.acquire).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled(); }
function assertNoProviderMutation() { expect(provider.createPolicy).not.toHaveBeenCalled(); expect(provider.createWallet).not.toHaveBeenCalled(); }
async function prepare() { const response = await post(preparePath, { idempotencyKey: randomUUID() }).expect(200).expect("Cache-Control", "no-store"); return copyAgentSetupSchema.parse(response.body.data); }

beforeAll(async () => {
  vi.stubEnv("AUTH_SERVICE_TOKEN", serviceToken); vi.stubEnv("AUTH_SERVICE_PERMISSIONS", "copy.read,execution.pause");
  ({ app, auth } = await createAuthedApp({ db, privy, controllers: [CopyAgentController], providers: [CopyAgentService, CopyAgentRepository,
    { provide: CopyWalletService, useValue: wallets }, { provide: USER_AGENT_PROVISIONER, useValue: provider }, { provide: AGENT_APPROVAL_CLIENT, useValue: exchange }] }));
});
beforeEach(async () => {
  await truncateAll(db); auth.clearCache(); vi.clearAllMocks(); walletExists = false; exchangeApproved = false;
  uid = (await insertUser(db, { privyUserId: "did:privy:agent-route-alice", embeddedWalletAddress: owner.address.toLowerCase() })).id;
  await insertUser(db, { privyUserId: "did:privy:agent-route-bob", embeddedWalletAddress: agent.address.toLowerCase() });
  strategyId = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: agent.address.toLowerCase(), allocated: "100", cash: "100", activatedAt: new Date() }).returning())[0].id;
  await db.insert(copyExecutionAccounts).values({ id: accountId, userId: uid, strategyId, network: "testnet", privyUserId: "did:privy:agent-route-alice", externalId: "master-external", state: "ready", address: master.address.toLowerCase(), privyWalletId: "master-provider-wallet", ownerQuorumId: "user-quorum" });
  wallets.reconcile.mockResolvedValue({ id: accountId, state: "ready", network: "testnet", address: master.address.toLowerCase() });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await app?.close(); await closeTestDb(); vi.unstubAllEnvs(); });

describe("explicit strategy agent authenticated HTTP routes", () => {
  it("rejects anonymous, invalid, expired and service callers on every endpoint before side effects", async () => {
    for (const token of [null, "bad-token", "expired", serviceToken]) {
      const status = token === serviceToken ? 403 : 401;
      const summary = request(app.getHttpServer()).get("/me/copy/agents"); if (token) summary.set("Authorization", `Bearer ${token}`); await summary.expect(status);
      const id = randomUUID();
      for (const [path, body] of [[preparePath, { idempotencyKey: randomUUID(), validForDays: 7 }], [setupPath(id, "reconcile"), {}]] as [string, object][]) {
        const call = request(app.getHttpServer()).post(path).send(body); if (token) call.set("Authorization", `Bearer ${token}`); await call.expect(status);
      }
    }
    assertNoProviderMutation(); assertNoApproval(); expect(wallets.reconcile).not.toHaveBeenCalled(); expect(await db.select().from(copyAgentSetups)).toHaveLength(0);
  });

  it("rejects a disabled owner on every endpoint even after the access token is cached", async () => {
    await get().expect(200); await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid));
    await get().expect(401);
    await post(preparePath, { idempotencyKey: randomUUID() }).expect(401);
    await post(setupPath(randomUUID(), "reconcile"), {}).expect(401);
    assertNoProviderMutation(); assertNoApproval(); expect(wallets.reconcile).not.toHaveBeenCalled();
  });

  it("prepares a ready agent with canonical no-store responses; there is no browser-signed challenge or approve (the setup's worker approves it)", async () => {
    const prepared = await prepare(); expect(prepared).toMatchObject({ state: "ready", accountAddress: master.address.toLowerCase(), agentAddress: agent.address.toLowerCase() });
    assertNoApproval(); expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
    const summary = await get().expect(200).expect("Cache-Control", "no-store"); expect(copyAgentOverviewSchema.parse(summary.body.data).setups).toEqual([prepared]);
    expect(JSON.stringify(summary.body)).not.toMatch(/provider-wallet|did:privy|worker-quorum|agent-policy|user-quorum|idempotencyKey/);
    await post(setupPath(prepared.id, "challenge"), {}).expect(404);
    await post(setupPath(prepared.id, "approve"), { consentSignature: fakeSignature, masterSignature: fakeSignature }).expect(404);
    assertNoApproval();
    const recovered = await post(setupPath(prepared.id, "reconcile"), {}).expect(200).expect("Cache-Control", "no-store"); expect(recovered.body.data.state).toBe("ready");
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ mode: "paper", cash: "100", allocated: "100" });
  });

  it("isolates every mutation and overview from another owner before provider or signer calls", async () => {
    const prepared = await prepare(); vi.clearAllMocks();
    const summary = await get("bob").expect(200); expect(copyAgentOverviewSchema.parse(summary.body.data).setups).toEqual([]);
    await post(preparePath, { idempotencyKey: randomUUID() }, "bob").expect(404);
    await post(setupPath(prepared.id, "reconcile"), {}, "bob").expect(404);
    assertNoProviderMutation(); assertNoApproval(); expect(provider.findOwned).not.toHaveBeenCalled(); expect(wallets.reconcile).not.toHaveBeenCalled();
    expect(await db.select().from(copyAgentSetups)).toHaveLength(1); expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
  });

  it("rejects malformed preparation DTOs and account/network/provider overrides before provider calls", async () => {
    for (const input of [{}, [], { idempotencyKey: "" }, { idempotencyKey: 1 }, { idempotencyKey: "a".repeat(129) }, ...[0, 31, 1.5, "7", null].map((validForDays) => ({ idempotencyKey: "key", validForDays })), ...[{ userId: uid }, { network: "mainnet" }, { accountAddress: owner.address }, { agentAddress: owner.address }, { workerQuorumId: "other" }, { policyId: "other" }, { userJwt: "secret" }, { consentSignature: fakeSignature, masterSignature: fakeSignature }].map((extra) => ({ idempotencyKey: "key", ...extra }))]) await post(preparePath, input).expect(400);
    await post("/me/copy/execution-wallets/bad%20id/agent", { idempotencyKey: "key" }).expect(400);
    assertNoProviderMutation(); assertNoApproval(); expect(wallets.reconcile).not.toHaveBeenCalled(); expect(await db.select().from(copyAgentSetups)).toHaveLength(0);
  });

  it("rejects a malformed setup id before any provider call", async () => {
    await post(setupPath("bad%20id", "reconcile"), {}).expect(400);
    assertNoApproval(); expect(provider.findOwned).not.toHaveBeenCalled(); expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
  });

  it("blocks mainnet account setup without signing", async () => {
    await db.update(copyExecutionAccounts).set({ network: "mainnet" }).where(eq(copyExecutionAccounts.id, accountId));
    await post(preparePath, { idempotencyKey: "mainnet" }).expect(409); assertNoProviderMutation(); assertNoApproval();
  });

  it("an expired setup's recovery reads expired without approval", async () => {
    const prepared = await prepare(); vi.clearAllMocks();
    await db.update(copyAgentSetups).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(copyAgentSetups.id, prepared.id));
    const recovery = await post(setupPath(prepared.id, "reconcile"), {}).expect(200); expect(recovery.body.data.state).toBe("expired");
    assertNoApproval(); expect(provider.findOwned).not.toHaveBeenCalled(); expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
  });
});
