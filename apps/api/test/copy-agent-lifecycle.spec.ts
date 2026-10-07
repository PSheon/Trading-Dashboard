import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { copyAgentSetups, copyExecutionAccounts, copyLiveSetups, copyExecutionWallets, copyStrategies, copyWalletAuthorizations, copyWalletAuthorizationEvents, users } from "@trading-dashboard/shared/database";
import { CopyAgentRepository } from "../src/copy/copy-agent.repository.js";
import { LiveBoundaryError } from "../src/copy/live/wallet-authorization.js";
import { CopyAgentService } from "../src/copy/copy-agent.service.js";
import { FUNDING_NONCE_EXPIRY_MS } from "../src/copy/copy-funding-scan.js";
import { CopyWalletRepository } from "../src/copy/copy-wallet.repository.js";
import { CopyWalletService } from "../src/copy/copy-wallet.service.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { agentApprovalTypedData, type AgentConsentIntent } from "../src/copy/copy-agent-consent.js";
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
  exchange = { available: true, acquire: vi.fn(async () => undefined), 
    send: vi.fn(async () => { approvalExists = true; return { status: "ok", response: { type: "default" } }; }),
    observe: vi.fn(async (intent) => approvalExists ? { checkedAt: Date.now(), validUntil: intent.expiresAt } : null) };
  service = new CopyAgentService(new CopyAgentRepository(db), new UnitOfWork(db), testConfig(), wallets as never, provider, exchange);
});
afterAll(closeTestDb);
afterEach(() => vi.restoreAllMocks());
/** The agent's one-click setup (its consent bound this agent), once. */
async function linkSetup(id: string) {
  await db.insert(copyLiveSetups).values({ id: 'setup-1', userId: uid, strategyId, kind: 'start', idempotencyKey: 'agent-signing-setup-0001', leaderAddress: `0x${'44'.repeat(20)}`,
    sourceNetwork: 'mainnet', budgetUsd: '100', settings: {} }).onConflictDoNothing();
  await db.update(copyAgentSetups).set({ liveSetupId: 'setup-1' }).where(eq(copyAgentSetups.id, id));
}
/** The approval's nonce, as a setup's agent step allocates it. */
async function challengeOf(id: string) { await linkSetup(id); return { intent: await service.challengeRow(uid, id) }; }
/** A setup's approval: the worker signs the ApproveAgent as the copy account (a key here). */
const approveAs = (id: string, userId = uid, on: CopyAgentService = service) => on.submit(userId, id, { kind: "setup", consentDigest: "c".repeat(64),
  sign: async (_account, intent, assertFresh) => { assertFresh(); return master.signTypedData(agentApprovalTypedData(intent)); } });
describe("explicit recoverable dedicated strategy agent setup", () => {
  it("prepares a user-owned agent without approval, trading or paper balance changes", async () => {
    const result = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    expect(result.state).toBe("ready"); expect(result.agentAddress).toBe(agent.address.toLowerCase());
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ mode: "paper", cash: "100" });
    expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
    expect(exchange.send).not.toHaveBeenCalled();
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
  it("only the owner's own setup can approve; grant follows fresh exchange evidence", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    await challengeOf(prepared.id);
    await expect(approveAs(prepared.id, stranger)).rejects.toThrow();
    vi.mocked(exchange.send).mockImplementation(async () => {
      const [row] = await db.select().from(copyAgentSetups);
      expect(row.state).toBe("approval_unknown"); expect(row.approvalAttemptedAt).not.toBeNull();
      expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
      approvalExists = true; return { status: "ok", response: { type: "default" } };
    });
    const result = await approveAs(prepared.id);
    expect(result.state).toBe("active"); expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(1);
    await approveAs(prepared.id);
    expect(exchange.send).toHaveBeenCalledTimes(1);
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ mode: "paper", cash: "100" });
  });
  it("an approval runs across real reconciles of the copy account without moving the revision its running generation binds", async () => {
    // The real wallet service: every challenge, submit and observation checks the account with Privy.
    const walletProvider = { available: true, create: vi.fn(), findOwned: vi.fn(async () => ({ id: "master-wallet", address: master.address.toLowerCase(), externalId: "master-external", ownerQuorumId: "user-quorum" })) };
    const realWallets = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), testConfig(), walletProvider as never);
    const real = new CopyAgentService(new CopyAgentRepository(db), new UnitOfWork(db), testConfig(), realWallets, provider, exchange);
    const [before] = await db.select().from(copyExecutionAccounts);
    const prepared = await real.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    await challengeOf(prepared.id);
    const result = await approveAs(prepared.id, uid, real);
    expect(result.state).toBe("active");
    expect(walletProvider.findOwned.mock.calls.length).toBeGreaterThanOrEqual(3);
    const [after] = await db.select().from(copyExecutionAccounts);
    expect(after).toMatchObject({ state: "ready", revision: before.revision, updatedAt: before.updatedAt });
  });
  it("an approval whose POST never reached the transport is ready again (same nonce), not pending forever", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    const challenge = await challengeOf(prepared.id);
    vi.mocked(exchange.send).mockRejectedValueOnce(new LiveBoundaryError("agent_approval_not_dispatched"));
    expect(await approveAs(prepared.id)).toMatchObject({ state: "ready", issue: "agent_approval_not_submitted" });
    expect((await db.select().from(copyAgentSetups))[0]).toMatchObject({ approvalAttemptedAt: null, approvalNonce: challenge.intent.nonce });
    expect((await approveAs(prepared.id)).state).toBe("active");
    expect(exchange.send).toHaveBeenCalledTimes(2);
  });
  it("accepted but unobserved approval stays pending across restart, never resubmits", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    await challengeOf(prepared.id);
    vi.mocked(exchange.send).mockImplementation(async () => { throw new Error("ambiguous"); });
    expect((await approveAs(prepared.id)).state).toBe("approval_unknown");
    expect((await service.reconcile(uid, prepared.id)).state).toBe("approval_unknown");
    expect(exchange.send).toHaveBeenCalledTimes(1); expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
    approvalExists = true;
    expect((await service.reconcile(uid, prepared.id)).state).toBe("active");
  });
  it("an unknown approval read after its nonce expired, with no such agent on the account, ends not executed", async () => {
    const expired = Date.now() - FUNDING_NONCE_EXPIRY_MS - 60_000;
    const lost = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    await challengeOf(lost.id);
    vi.mocked(exchange.send).mockImplementation(async () => { throw new Error("ambiguous"); });
    expect((await approveAs(lost.id)).state).toBe("approval_unknown");
    // Still inside the nonce window: no proof either way, it waits.
    expect((await service.reconcile(uid, lost.id)).state).toBe("approval_unknown");
    await db.update(copyAgentSetups).set({ approvalNonce: expired }).where(eq(copyAgentSetups.id, lost.id));
    expect(await service.reconcile(uid, lost.id)).toMatchObject({ state: "blocked", issue: "agent_approval_not_executed" });
    expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
    expect(exchange.send).toHaveBeenCalledTimes(1);
  });
  it("an unknown approval read after its nonce expired that the account lists is active, not ended", async () => {
    const expired = Date.now() - FUNDING_NONCE_EXPIRY_MS - 60_000;
    vi.mocked(exchange.send).mockImplementation(async () => { throw new Error("ambiguous"); });
    const landed = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    await challengeOf(landed.id);
    expect((await approveAs(landed.id)).state).toBe("approval_unknown");
    await db.update(copyAgentSetups).set({ approvalNonce: expired }).where(eq(copyAgentSetups.id, landed.id));
    approvalExists = true;
    expect((await service.reconcile(uid, landed.id)).state).toBe("active");
  });
  it("owner disablement after the worker signed blocks the exchange POST", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    await challengeOf(prepared.id);
    // Disabled after the worker signed, before the final identity proof.
    vi.mocked(exchange.acquire).mockImplementation(async () => { await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid)); });
    await expect(approveAs(prepared.id)).rejects.toThrow();
    expect(exchange.send).not.toHaveBeenCalled(); expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
  });
  it("changed policy or worker identity cannot produce a grant", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    await challengeOf(prepared.id);
    vi.mocked(provider.findOwned).mockResolvedValue({ id: "agent-wallet", address: agent.address.toLowerCase(), externalId: "wrong", ownerQuorumId: "user-quorum", policyId: "user-policy", workerQuorumId: "other-worker" });
    await expect(approveAs(prepared.id)).rejects.toThrow();
    expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
  });
  it("concurrent observers issue only one grant", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    await challengeOf(prepared.id);
    vi.mocked(exchange.send).mockRejectedValue(new Error("lost response"));
    await approveAs(prepared.id);
    approvalExists = true;
    const replica = new CopyAgentService(new CopyAgentRepository(db), new UnitOfWork(db), testConfig(), wallets as never, provider, exchange);
    const results = await Promise.all([service.reconcile(uid, prepared.id), replica.reconcile(uid, prepared.id)]);
    expect(results.every(row => row.state === "active")).toBe(true);
    expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(1);
  });
  it("local revocation is reflected in setup and cannot be restored by approving again", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    await challengeOf(prepared.id);
    const active = await approveAs(prepared.id);
    await db.update(copyWalletAuthorizations).set({ revokedAt: new Date(), version: 2 }).where(eq(copyWalletAuthorizations.id, active.authorizationId!));
    expect((await service.overview(uid)).setups[0].state).toBe("revoked");
    await expect(approveAs(prepared.id)).rejects.toThrow();
    expect(exchange.send).toHaveBeenCalledTimes(1);
    expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(1);
  });
  it("a policy changed while waiting for exchange budget blocks the approval POST", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "prepare-1", validForDays: 7 });
    await challengeOf(prepared.id);
    vi.mocked(exchange.acquire).mockImplementation(async () => {
      vi.mocked(provider.verifyPolicy).mockResolvedValue({ id: "user-policy", ownerQuorumId: "user-quorum", fingerprint: "b".repeat(64) });
    });
    await expect(approveAs(prepared.id)).rejects.toThrow();
    expect(exchange.send).not.toHaveBeenCalled();
    expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
  });

  it("carries the original identity proof to a setup's signing boundary", async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: 'signing-proof', validForDays: 7 });
    await challengeOf(prepared.id);
    let nativeCalls = 0;
    const sign = async (_account: unknown, intent: AgentConsentIntent, guard: () => void) => {
      const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now + 5001);
      try { guard(); nativeCalls++; return await master.signTypedData(agentApprovalTypedData(intent)); }
      finally { clock.mockRestore(); }
    };
    await expect(service.submit(uid, prepared.id, { kind: 'setup', consentDigest: 'c'.repeat(64), sign })).rejects.toThrow('agent_identity_evidence_expired');
    expect(nativeCalls).toBe(0); expect(exchange.send).not.toHaveBeenCalled();
    expect((await db.select().from(copyAgentSetups))[0].approvalAttemptedAt).toBeNull();
  });

  it('rechecks original identity proof after global exchange admission and preserves the attempted nonce', async () => {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: 'sending-proof', validForDays: 7 });
    await challengeOf(prepared.id);
    let nativeCalls = 0;
    vi.mocked(exchange.send).mockImplementation(async (_intent, _signature, guard?: () => void) => {
      const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now + 5001);
      try { if (!guard) throw new Error('missing native send guard'); guard(); nativeCalls++; return { status: 'ok', response: { type: 'default' } }; }
      finally { clock.mockRestore(); }
    });
    expect((await approveAs(prepared.id)).state).toBe('approval_unknown');
    expect(vi.mocked(exchange.send).mock.calls[0][2]).toEqual(expect.any(Function)); expect(nativeCalls).toBe(0);
    await approveAs(prepared.id); expect(exchange.send).toHaveBeenCalledTimes(1);
    expect((await db.select().from(copyAgentSetups))[0].approvalAttemptedAt).not.toBeNull();
  });

  async function pendingApproval() {
    const prepared = await service.prepare(uid, accountId, { idempotencyKey: "fresh-proof", validForDays: 7 });
    await challengeOf(prepared.id);
    vi.mocked(exchange.send).mockRejectedValue(new Error("response lost"));
    const result = await approveAs(prepared.id);
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
