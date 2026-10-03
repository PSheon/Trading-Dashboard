import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { copyAgentSetups, copyExecutionAccounts, copyExecutionWallets, copyStrategies, copyWalletAuthorizations, copyWalletAuthorizationEvents, users } from "@trading-dashboard/shared/database";
import { CopyAgentRepository } from "../src/copy/copy-agent.repository.js";
import { CopyAgentService } from "../src/copy/copy-agent.service.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { agentOwnerConsentTypedData, agentApprovalTypedData } from "../src/copy/copy-agent-consent.js";
import type { UserAgentProvisioner } from "../src/copy/live/privy-agent-provisioner.js";
import type { AgentApprovalClient } from "../src/copy/copy-agent-exchange.client.js";
import { testConfig } from "./config-test-utils.js";
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from "./db-test-utils.js";

const owner = privateKeyToAccount(`0x${"01".repeat(32)}`);
const master = privateKeyToAccount(`0x${"02".repeat(32)}`);
const agent = privateKeyToAccount(`0x${"03".repeat(32)}`);
let db: TestDb; let uid: number; let stranger: number; let strategyId: number; let accountId: string;
let service: CopyAgentService; let provider: UserAgentProvisioner; let exchange: AgentApprovalClient;
let walletExists: boolean; let approvalExists: boolean;
const wallets = { reconcile: vi.fn(), overview: vi.fn() };
beforeAll(() => { db = getTestDb(); });
beforeEach(async () => {
  await truncateAll(db); walletExists = false; approvalExists = false;
  uid = (await insertUser(db, { privyUserId: "did:privy:agent-owner", embeddedWalletAddress: owner.address.toLowerCase() })).id;
  stranger = (await insertUser(db)).id;
  strategyId = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: agent.address.toLowerCase(), allocated: "100", cash: "100", activatedAt: new Date() }).returning())[0].id;
  accountId = "account-1";
  await db.insert(copyExecutionAccounts).values({ id: accountId, userId: uid, strategyId, network: "testnet", privyUserId: "did:privy:agent-owner",
    externalId: "master-external", state: "ready", address: master.address.toLowerCase(), privyWalletId: "master-wallet", ownerQuorumId: "user-quorum" });
  wallets.reconcile.mockResolvedValue({ id: accountId, state: "ready", address: master.address.toLowerCase(), network: "testnet" });
  wallets.overview.mockResolvedValue({ available: true });
  provider = { available: true, configuredWorkerQuorumId: "worker-quorum", verifyWorkerQuorum: vi.fn(async () => undefined),
    createPolicy: vi.fn(async () => ({ id: "user-policy" })),
    verifyPolicy: vi.fn(async () => ({ id: "user-policy", ownerQuorumId: "user-quorum", fingerprint: "a".repeat(64) })),
    createWallet: vi.fn(async () => { walletExists = true; }),
    findOwned: vi.fn(async (input) => walletExists ? ({ id: "agent-wallet", address: agent.address.toLowerCase(), externalId: input.externalId,
      ownerQuorumId: "user-quorum", policyId: "user-policy", workerQuorumId: "worker-quorum" }) : null),
  };
  exchange = { available: true, acquire: vi.fn(async () => undefined), signMaster: vi.fn(async (_account, intent) => master.signTypedData(agentApprovalTypedData(intent))),
    send: vi.fn(async () => { approvalExists = true; return { status: "ok", response: { type: "default" } }; }),
    observe: vi.fn(async (intent) => approvalExists ? { checkedAt: Date.now(), validUntil: intent.expiresAt } : null) };
  service = new CopyAgentService(new CopyAgentRepository(db), new UnitOfWork(db), testConfig(), wallets as never, provider, exchange);
});
afterAll(closeTestDb);
afterEach(() => vi.restoreAllMocks());
describe("explicit recoverable dedicated strategy agent setup", () => {
  it("prepares a user-owned agent without approval, trading or paper balance changes", async () => {
    const result = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    expect(result.state).toBe("ready"); expect(result.agentAddress).toBe(agent.address.toLowerCase());
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ mode: "paper", cash: "100" });
    expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
    expect(exchange.signMaster).not.toHaveBeenCalled(); expect(exchange.send).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("privyUserId");
  });
  it("two replicas claim each provider creation once", async () => {
    const replica = new CopyAgentService(new CopyAgentRepository(db), new UnitOfWork(db), testConfig(), wallets as never, provider, exchange);
    const results = await Promise.all([service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 }), replica.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 })]);
    expect(results[0].id).toBe(results[1].id); expect(provider.createPolicy).toHaveBeenCalledTimes(1); expect(provider.createWallet).toHaveBeenCalledTimes(1);
  });
  it("an ambiguous policy creation remains pending and is never automatically created again", async () => {
    vi.mocked(provider.createPolicy).mockRejectedValue(new Error("secret provider error"));
    const result = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    expect(result.state).toBe("policy_unknown");
    expect((await service.reconcile(uid, result.id)).state).toBe("policy_unknown");
    expect(provider.createPolicy).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("a lost agent create response recovers by immutable external identity", async () => {
    vi.mocked(provider.createWallet).mockImplementation(async () => { walletExists = true; throw new Error("timeout"); });
    const result = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    expect(result.state).toBe("wallet_unknown");
    expect((await service.reconcile(uid, result.id)).state).toBe("ready");
    expect(provider.createWallet).toHaveBeenCalledTimes(1);
  });
  it("only exact owner-signed consent can approve; grant follows fresh exchange evidence", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    const challenge = await service.challenge(uid, prepared.id);
    const signature = await owner.signTypedData(agentOwnerConsentTypedData(challenge.intent));
    await expect(service.approve(stranger, prepared.id, signature, "user-jwt")).rejects.toThrow();
    vi.mocked(exchange.send).mockImplementation(async () => {
      const [row] = await db.select().from(copyAgentSetups);
      expect(row.state).toBe("approval_unknown"); expect(row.approvalAttemptedAt).not.toBeNull();
      expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
      approvalExists = true; return { status: "ok", response: { type: "default" } };
    });
    const result = await service.approve(uid, prepared.id, signature, "user-jwt");
    expect(result.state).toBe("active"); expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(1);
    await service.approve(uid, prepared.id, signature, "user-jwt");
    expect(exchange.send).toHaveBeenCalledTimes(1);
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ mode: "paper", cash: "100" });
  });
  it("accepted but unobserved approval stays pending across restart, never resubmits", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    const challenge = await service.challenge(uid, prepared.id);
    vi.mocked(exchange.send).mockImplementation(async () => { throw new Error("ambiguous"); });
    const signature = await owner.signTypedData(agentOwnerConsentTypedData(challenge.intent));
    expect((await service.approve(uid, prepared.id, signature, "user-jwt")).state).toBe("approval_unknown");
    expect((await service.reconcile(uid, prepared.id)).state).toBe("approval_unknown");
    expect(exchange.send).toHaveBeenCalledTimes(1); expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
    approvalExists = true;
    expect((await service.reconcile(uid, prepared.id)).state).toBe("active");
  });
  it("owner disablement while Privy signing blocks the exchange POST", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    const challenge = await service.challenge(uid, prepared.id);
    vi.mocked(exchange.signMaster).mockImplementation(async (_account, intent) => {
      await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid));
      return master.signTypedData(agentApprovalTypedData(intent));
    });
    const signature = await owner.signTypedData(agentOwnerConsentTypedData(challenge.intent));
    await expect(service.approve(uid, prepared.id, signature, "user-jwt")).rejects.toThrow();
    expect(exchange.send).not.toHaveBeenCalled(); expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
  });
  it("changed policy or worker identity cannot produce a grant", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    const challenge = await service.challenge(uid, prepared.id);
    vi.mocked(provider.findOwned).mockResolvedValue({ id: "agent-wallet", address: agent.address.toLowerCase(), externalId: "wrong", ownerQuorumId: "user-quorum", policyId: "user-policy", workerQuorumId: "other-worker" });
    const signature = await owner.signTypedData(agentOwnerConsentTypedData(challenge.intent));
    await expect(service.approve(uid, prepared.id, signature, "user-jwt")).rejects.toThrow();
    expect(exchange.signMaster).not.toHaveBeenCalled(); expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
  });
  it("concurrent observers issue only one grant", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    const challenge = await service.challenge(uid, prepared.id);
    vi.mocked(exchange.send).mockRejectedValue(new Error("lost response"));
    await service.approve(uid, prepared.id, await owner.signTypedData(agentOwnerConsentTypedData(challenge.intent)), "user-jwt");
    approvalExists = true;
    const replica = new CopyAgentService(new CopyAgentRepository(db), new UnitOfWork(db), testConfig(), wallets as never, provider, exchange);
    const results = await Promise.all([service.reconcile(uid, prepared.id), replica.reconcile(uid, prepared.id)]);
    expect(results.every(row => row.state === "active")).toBe(true);
    expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(1);
  });
  it("local revocation is reflected in setup and cannot be restored by replaying consent", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    const challenge = await service.challenge(uid, prepared.id);
    const signature = await owner.signTypedData(agentOwnerConsentTypedData(challenge.intent));
    const active = await service.approve(uid, prepared.id, signature, "user-jwt");
    await db.update(copyWalletAuthorizations).set({ revokedAt: new Date(), version: 2 }).where(eq(copyWalletAuthorizations.id, active.authorizationId!));
    expect((await service.overview(uid)).setups[0].state).toBe("revoked");
    await expect(service.approve(uid, prepared.id, signature, "user-jwt")).rejects.toThrow();
    expect(exchange.send).toHaveBeenCalledTimes(1);
    expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(1);
  });
  it("a policy changed while waiting for exchange budget blocks the approval POST", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    const challenge = await service.challenge(uid, prepared.id);
    vi.mocked(exchange.acquire).mockImplementation(async () => {
      vi.mocked(provider.verifyPolicy).mockResolvedValue({ id: "user-policy", ownerQuorumId: "user-quorum", fingerprint: "b".repeat(64) });
    });
    await expect(service.approve(uid, prepared.id, await owner.signTypedData(agentOwnerConsentTypedData(challenge.intent)), "user-jwt")).rejects.toThrow();
    expect(exchange.send).not.toHaveBeenCalled();
    expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
  });

  async function pendingApproval() {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "fresh-proof", validForDays: 7 });
    const challenge = await service.challenge(uid, prepared.id);
    vi.mocked(exchange.send).mockRejectedValue(new Error("response lost"));
    const result = await service.approve(uid, prepared.id, await owner.signTypedData(agentOwnerConsentTypedData(challenge.intent)), "user-jwt");
    expect(result.state).toBe("approval_unknown"); approvalExists = true; return result;
  }

  it.each([[0, 5001], [3000, 3000]])("does not discard provider proof age after %sms of identity reads and %sms of exchange reads", async (identityDelay, exchangeDelay) => {
    const pending = await pendingApproval(); let clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock);
    const find = vi.mocked(provider.findOwned).getMockImplementation()!;
    vi.mocked(provider.findOwned).mockImplementation(async (input) => { const result = await find(input); clock += identityDelay; return result; });
    vi.mocked(exchange.observe).mockImplementation(async (intent) => { clock += exchangeDelay; return { checkedAt: clock, validUntil: intent.expiresAt }; });
    expect((await service.reconcile(uid, pending.id)).state).toBe("approval_unknown");
    expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0); expect(exchange.send).toHaveBeenCalledTimes(1);
  });

  it("permits the exact five-second combined proof boundary", async () => {
    const pending = await pendingApproval(); let clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.mocked(exchange.observe).mockImplementation(async (intent) => { clock += 5000; return { checkedAt: clock, validUntil: intent.expiresAt }; });
    expect((await service.reconcile(uid, pending.id)).state).toBe("active"); expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(1);
  });

  it.each(["wallet", "authorization"] as const)("rolls back activation and old grant retirement when the %s SQL lock ages the oldest proof", async (kind) => {
    const pending = await pendingApproval();
    await db.insert(copyExecutionWallets).values({ id: "old-wallet", userId: uid, strategyId, network: "testnet", accountAddress: master.address.toLowerCase(), privyWalletId: "old-provider-wallet", privyOwnerId: "old-owner", signerAddress: agent.address.toLowerCase() });
    await db.insert(copyWalletAuthorizations).values({ id: "old-grant", walletId: "old-wallet", version: 1, scopes: ["copy:trade"], validFrom: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() + 86400000), exchangeApprovedAt: new Date() });
    let clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock);
    let acquired!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => { acquired = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
    const blocker = db.transaction(async (tx) => {
      if (kind === "wallet") await tx.select().from(copyExecutionWallets).where(eq(copyExecutionWallets.id, "old-wallet")).for("update");
      else await tx.select().from(copyWalletAuthorizations).where(eq(copyWalletAuthorizations.id, "old-grant")).for("update");
      acquired(); await released;
    });
    await held;
    const reconciliation = service.reconcile(uid, pending.id);
    try {
      const table = kind === "wallet" ? "copy_execution_wallets" : "copy_wallet_authorizations";
      let waiting = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const status = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like ${`%${table}%`}) as waiting`);
        if (status.rows[0]?.waiting) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true); clock += 5001;
    } finally { release(); await blocker; }
    const result = await reconciliation;
    expect(result.state).toBe("approval_unknown");
    expect(await db.select().from(copyExecutionWallets)).toMatchObject([{ id: "old-wallet", retiredAt: null }]);
    expect(await db.select().from(copyWalletAuthorizations)).toMatchObject([{ id: "old-grant", version: 1, revokedAt: null }]);
    expect(await db.select().from(copyWalletAuthorizationEvents)).toHaveLength(0);
    vi.restoreAllMocks();
    expect((await service.reconcile(uid, pending.id)).state).toBe("active");
    expect(exchange.send).toHaveBeenCalledTimes(1); expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(2);
  });
});
