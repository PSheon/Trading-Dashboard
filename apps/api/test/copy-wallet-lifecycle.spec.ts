import { exchangeApprovalFixture } from "./copy-live-test-utils.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { copyAgentSetups, copyExecutionAccounts, copyExecutionWallets, copyLiveSetups, copyStrategies, copyWalletAuthorizations, copyWalletAuthorizationEvents, users } from "@trading-dashboard/shared/database";
import { copyExecutionWalletsSchema } from "@trading-dashboard/shared/contracts";
import { CopyWalletRepository } from "../src/copy/copy-wallet.repository.js";
import { CopyWalletService } from "../src/copy/copy-wallet.service.js";
import { MasterPolicyConflict } from "../src/copy/live/privy-master-policy.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { PostgresWalletAuthorizationSource } from "../src/copy/live/postgres-wallet-authorizations.js";
import { WalletAuthorizationService } from "../src/copy/live/wallet-authorization.js";
import { ProvisioningVerificationPending, ProvisioningWalletConflict, type ProvisionedUserWallet, type UserWalletProvisioner } from "../src/copy/live/privy-wallet-provisioner.js";
import { testConfig } from "./config-test-utils.js";
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from "./db-test-utils.js";

let db: TestDb;
let uid: number;
let stranger: number;
let strategy: number;
let stored: ProvisionedUserWallet | null;
let provider: UserWalletProvisioner;
let service: CopyWalletService;
const addr = `0x${"22".repeat(20)}` as const;
const signer = `0x${"11".repeat(20)}` as const;
beforeAll(() => { db = getTestDb(); });
beforeEach(async () => {
  await truncateAll(db);
  uid = (await insertUser(db, { privyUserId: "did:privy:wallet-owner" })).id;
  stranger = (await insertUser(db)).id;
  strategy = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: addr, allocated: "100", cash: "100", activatedAt: new Date() }).returning())[0].id;
  stored = null;
  provider = { available: true,
    create: vi.fn(async (_user, externalId) => { stored = { id: "provider-wallet", address: addr, externalId, ownerQuorumId: "verified-user-quorum" }; }),
    findOwned: vi.fn(async () => stored),
  };
  service = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), testConfig(), provider);
});
afterAll(closeTestDb);

describe("dedicated user-owned execution wallet lifecycle", () => {
  it("read has no provider mutation and exposes no owner/provider identity", async () => {
    expect(copyExecutionWalletsSchema.parse(await service.overview(uid))).toEqual({ available: true, network: "testnet", accounts: [], authorizations: [] });
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.findOwned).not.toHaveBeenCalled();
    const result = await service.prepare(uid, strategy, { network: "testnet" });
    expect(result.state).toBe("ready");
    expect(result.address).toBe(addr);
    expect(Object.keys(result)).not.toContain("privyWalletId");
    expect(Object.keys(result)).not.toContain("privyUserId");
    const [row] = await db.select().from(copyExecutionAccounts);
    expect(provider.create).toHaveBeenCalledWith("did:privy:wallet-owner", row.externalId);
    expect(row.externalId).toMatch(/^copy_[a-z0-9]{32}$/);
    expect((await db.select().from(copyStrategies))[0]).toMatchObject({ mode: "paper", cash: "100" });
    expect(await db.select().from(copyWalletAuthorizations)).toHaveLength(0);
  });
  it("concurrent replicas create once and repeated requests reuse the same account", async () => {
    const second = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), testConfig(), provider);
    const results = await Promise.all([service.prepare(uid, strategy, { network: "testnet" }), second.prepare(uid, strategy, { network: "testnet" })]);
    expect(results[0].id).toBe(results[1].id);
    expect(provider.create).toHaveBeenCalledTimes(1);
    const replay = await second.prepare(uid, strategy, { network: "testnet" });
    expect(replay).toMatchObject({ id: results[0].id, state: "ready", address: addr });
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(await db.select().from(copyExecutionAccounts)).toHaveLength(1);
  });
  it("commits unknown before provider POST and recovers a lost creation response after restart", async () => {
    vi.mocked(provider.create).mockImplementation(async (_user, externalId) => {
      const [row] = await db.select().from(copyExecutionAccounts);
      expect(row.state).toBe("unknown");
      stored = { id: "provider-wallet", address: addr, externalId, ownerQuorumId: "verified-user-quorum" };
      throw new Error("Secret remote exception text");
    });
    const initial = await service.prepare(uid, strategy, { network: "testnet" });
    expect(initial.state).toBe("unknown");
    expect(initial.address).toBeNull();
    expect(JSON.stringify(initial)).not.toContain("Secret");
    const restarted = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), testConfig(), provider);
    expect(await restarted.reconcile(uid, initial.id)).toMatchObject({ state: "ready", address: addr });
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
  it("missing evidence for an unknown intent never authorizes a new creation", async () => {
    vi.mocked(provider.create).mockRejectedValue(new Error("timeout"));
    const initial = await service.prepare(uid, strategy, { network: "testnet" });
    expect(initial.state).toBe("unknown");
    for (let i = 0; i < 3; i++) expect((await service.reconcile(uid, initial.id)).state).toBe("unknown");
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
  it("a crash after the durable claim but before POST stays lookup-only after restart", async () => {
    await db.insert(copyExecutionAccounts).values({ id: "crashed-account", userId: uid, strategyId: strategy, network: "testnet",
      privyUserId: "did:privy:wallet-owner", externalId: "copy_crashed_claim", state: "unknown", issue: "verification_pending" });
    const restarted = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), testConfig(), provider);
    expect(await restarted.reconcile(uid, "crashed-account")).toMatchObject({ state: "unknown", address: null });
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.findOwned).toHaveBeenCalledWith("did:privy:wallet-owner", "copy_crashed_claim", null);
  });
  it("a failed pre-create lookup can retry without losing the unsubmitted intent", async () => {
    vi.mocked(provider.findOwned).mockRejectedValueOnce(new Error("lookup unavailable"));
    const initial = await service.prepare(uid, strategy, { network: "testnet" });
    expect(initial).toMatchObject({ state: "requested", issue: "provider_unavailable" });
    expect(provider.create).not.toHaveBeenCalled();
    expect((await service.reconcile(uid, initial.id)).state).toBe("ready");
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
  it("refuses foreign strategies/accounts, disabled users, stopped copies and wrong network", async () => {
    await expect(service.prepare(stranger, strategy, { network: "testnet" })).rejects.toThrow("Copy strategy not found");
    await expect(service.prepare(uid, strategy, { network: "mainnet" })).rejects.toThrow("wallet_network_mismatch");
    await expect(service.prepare(uid, strategy, { network: "testnet", ownerId: "injected" })).rejects.toThrow("Invalid execution wallet request");
    expect(provider.create).not.toHaveBeenCalled();
    const prepared = await service.prepare(uid, strategy, { network: "testnet" });
    await expect(service.reconcile(stranger, prepared.id)).rejects.toThrow("Execution wallet not found");
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, uid));
    await expect(service.reconcile(uid, prepared.id)).rejects.toThrow("User not found");
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, uid));
    await db.update(copyStrategies).set({ status: "stopped", stoppedAt: new Date() }).where(eq(copyStrategies.id, strategy));
    await expect(service.prepare(uid, strategy, { network: "testnet" })).rejects.toThrow("copy_stopped");
  });
  it("blocks provider ownership/identity conflicts and never exposes an unverified address", async () => {
    vi.mocked(provider.findOwned).mockRejectedValue(new ProvisioningWalletConflict("wallet_conflict"));
    const row = await service.prepare(uid, strategy, { network: "testnet" });
    expect(row).toMatchObject({ state: "blocked", issue: "wallet_conflict", address: null });
    expect(provider.create).not.toHaveBeenCalled();
    expect((await service.reconcile(uid, row.id)).state).toBe("blocked");
  });
  it("blocks an identity change in a previously verified account", async () => {
    const initial = await service.prepare(uid, strategy, { network: "testnet" });
    stored = { ...stored!, ownerQuorumId: "foreign-quorum" };
    expect(await service.reconcile(uid, initial.id)).toMatchObject({ state: "blocked", address: null });
  });
  it("blocks a wallet/address already bound to another strategy through wrapped database errors", async () => {
    const first = await service.prepare(uid, strategy, { network: "testnet" });
    const next = (await db.insert(copyStrategies).values({ userId: uid, leaderAddress: signer, allocated: "100", cash: "100", activatedAt: new Date() }).returning())[0].id;
    stored = null;
    expect(await service.prepare(uid, next, { network: "testnet" })).toMatchObject({ state: "blocked", address: null, issue: "wallet_conflict" });
    expect((await service.overview(uid)).accounts.find((row) => row.id === first.id)?.state).toBe("ready");
  });
  it("keeps temporarily incomplete ownership evidence recoverable without another creation", async () => {
    vi.mocked(provider.findOwned).mockRejectedValueOnce(new ProvisioningVerificationPending("verification_pending"));
    const initial = await service.prepare(uid, strategy, { network: "testnet" });
    expect(initial).toMatchObject({ state: "unknown", issue: "verification_pending", address: null });
    stored = { id: "provider-wallet", address: addr, externalId: (await db.select().from(copyExecutionAccounts))[0].externalId, ownerQuorumId: "verified-user-quorum" };
    expect((await service.reconcile(uid, initial.id)).state).toBe("ready");
    expect(provider.create).not.toHaveBeenCalled();
  });
  it("a reconcile that finds the account as it was changes nothing a consent binds (revision, updatedAt); a real change still moves it", async () => {
    const initial = await service.prepare(uid, strategy, { network: "testnet" });
    const [before] = await db.select().from(copyExecutionAccounts);
    for (let i = 0; i < 3; i++) expect((await service.reconcile(uid, initial.id)).state).toBe("ready");
    const [after] = await db.select().from(copyExecutionAccounts);
    expect(after).toMatchObject({ revision: before.revision, updatedAt: before.updatedAt });
    vi.mocked(provider.findOwned).mockRejectedValueOnce(new Error("provider unavailable"));
    await service.reconcile(uid, initial.id);
    expect((await service.reconcile(uid, initial.id)).state).toBe("ready");
    expect((await db.select().from(copyExecutionAccounts))[0].revision).toBe(before.revision + 2);
  });
  it("failed reverification hides a stale positive result until new proof arrives", async () => {
    const initial = await service.prepare(uid, strategy, { network: "testnet" });
    vi.mocked(provider.findOwned).mockRejectedValueOnce(new Error("provider unavailable"));
    expect(await service.reconcile(uid, initial.id)).toMatchObject({ state: "unknown", address: null, issue: "provider_unavailable" });
    expect((await service.reconcile(uid, initial.id)).state).toBe("ready");
    expect(provider.create).toHaveBeenCalledTimes(1);
  });
  it("a stale failure cannot downgrade a newer successful proof even within the same millisecond", async () => {
    const fixed = new Date();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixed);
    try {
      const initial = await service.prepare(uid, strategy, { network: "testnet" });
      let reject!: (error: Error) => void;
      let entered!: () => void;
      const waiting = new Promise<ProvisionedUserWallet | null>((_resolve, rejectPromise) => { reject = rejectPromise; });
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      vi.mocked(provider.findOwned).mockImplementationOnce(() => { entered(); return waiting; });
      const stale = service.reconcile(uid, initial.id);
      await ready;
      expect((await service.reconcile(uid, initial.id)).state).toBe("ready");
      reject(new Error("stale provider failure"));
      expect((await stale).state).toBe("ready");
      expect((await service.overview(uid)).accounts[0].state).toBe("ready");
    } finally { vi.useRealTimers(); }
  });
  it("concurrent conflicting positive identities never overwrite the first committed binding", async () => {
    let resolve!: (wallet: ProvisionedUserWallet) => void;
    let entered!: () => void;
    const wait = new Promise<ProvisionedUserWallet>((done) => { resolve = done; });
    const ready = new Promise<void>((done) => { entered = done; });
    vi.mocked(provider.findOwned).mockImplementationOnce(() => { entered(); return wait; });
    const older = service.prepare(uid, strategy, { network: "testnet" });
    await ready;
    const [row] = await db.select().from(copyExecutionAccounts);
    stored = { id: "first-committed-wallet", externalId: row.externalId, address: addr, ownerQuorumId: "verified-user-quorum" };
    expect((await service.prepare(uid, strategy, { network: "testnet" })).state).toBe("ready");
    resolve({ ...stored, id: "late-conflicting-wallet", address: signer });
    expect(await older).toMatchObject({ state: "blocked", address: null, issue: "wallet_conflict" });
    const [retained] = await db.select().from(copyExecutionAccounts);
    expect(retained.privyWalletId).toBe("first-committed-wallet");
    expect(retained.address).toBe(addr);
    expect(provider.create).not.toHaveBeenCalled();
  });
  it("does not create an account when provider is unconfigured", async () => {
    provider = { ...provider, available: false };
    service = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), testConfig(), provider);
    expect((await service.overview(uid)).available).toBe(false);
    await expect(service.prepare(uid, strategy, { network: "testnet" })).rejects.toThrow("wallet_provider_unavailable");
    expect(await db.select().from(copyExecutionAccounts)).toHaveLength(0);
  });
});

describe("owner consent revocation", () => {
  async function grant() {
    const account = await service.prepare(uid, strategy, { network: "testnet" });
    const expiresAt = new Date(Date.now() + 100_000);
    await db.insert(copyExecutionWallets).values({ id: "agent-wallet", userId: uid, strategyId: strategy, network: "testnet", accountAddress: addr,
      privyWalletId: "privy-agent", privyOwnerId: "server-quorum", signerAddress: signer });
    await db.insert(copyWalletAuthorizations).values({ id: "grant", walletId: "agent-wallet", version: 1,
      scopes: ["copy:trade", "copy:reduce"], validFrom: new Date(Date.now() - 10_000), expiresAt, exchangeApprovedAt: new Date(Date.now() - 5_000) });
    await db.insert(copyAgentSetups).values({ id: "active-setup", userId: uid, strategyId: strategy, accountId: account.id, network: "testnet",
      idempotencyKey: "wallet-revocation-setup", validForDays: 1, externalId: "revocation-agent", workerQuorumId: "worker-quorum", policyAttemptId: "policy-attempt",
      policyId: "agent-policy", policyFingerprint: "a".repeat(64), agentWalletId: "privy-agent", agentOwnerQuorumId: "server-quorum",
      agentAddress: signer, accountAddress: addr, accountWalletId: "provider-wallet", accountOwnerQuorumId: "verified-user-quorum",
      state: "active", authorizationId: "grant", expiresAt });
  }
  it("revokes atomically once across concurrent requests and survives a new process", async () => {
    await grant();
    const authority = new WalletAuthorizationService(new PostgresWalletAuthorizationSource(db), exchangeApprovalFixture(Date.now));
    const input = { authorizationId: "grant", userId: uid, strategyId: strategy, walletId: "privy-agent", network: "testnet" as const, accountAddress: addr, reduceOnly: false };
    await expect(authority.authorize(input)).resolves.toMatchObject({ version: 1 });
    const [a, b] = await Promise.all([service.revoke(uid, "grant"), service.revoke(uid, "grant")]);
    expect(a).toEqual(b);
    expect(a.status).toBe("revoked");
    expect((await db.select().from(copyWalletAuthorizations))[0].version).toBe(2);
    expect(await db.select().from(copyWalletAuthorizationEvents)).toHaveLength(1);
    await expect(authority.authorize(input)).rejects.toThrow("authorization_revoked");
    expect(await new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), testConfig(), provider).revoke(uid, "grant")).toEqual(a);
  });
  it("a foreign owner cannot read or revoke, and expiration is displayed accurately", async () => {
    await grant();
    expect((await service.overview(stranger)).authorizations).toEqual([]);
    await expect(service.revoke(stranger, "grant")).rejects.toThrow("Wallet authorization not found");
    expect((await db.select().from(copyWalletAuthorizations))[0].revokedAt).toBeNull();
    await db.update(copyWalletAuthorizations).set({ exchangeApprovedAt: null }).where(eq(copyWalletAuthorizations.id, "grant"));
    expect((await service.overview(uid)).authorizations[0].status).toBe("pending");
    await db.update(copyWalletAuthorizations).set({ validFrom: new Date(Date.now() - 20_000), expiresAt: new Date(Date.now() - 10_000) })
      .where(and(eq(copyWalletAuthorizations.id, "grant"), eq(copyWalletAuthorizations.version, 1)));
    expect((await service.overview(uid)).authorizations[0].status).toBe("expired");
  });
  it("rolls back grant revocation when durable consent evidence cannot be inserted", async () => {
    await grant();
    await db.insert(copyWalletAuthorizationEvents).values({ id: "conflicting-audit", authorizationId: "grant", userId: uid, version: 2, action: "revoked" });
    await expect(service.revoke(uid, "grant")).rejects.toThrow();
    const [row] = await db.select().from(copyWalletAuthorizations);
    expect(row).toMatchObject({ version: 1, revokedAt: null });
    expect((await service.overview(uid)).authorizations[0].status).toBe("active");
  });
});

describe("the automatic return: the policy-bound worker signer the owner's browser added, recorded once Privy shows it (one-click plan §3b)", () => {
  const main = `0x${"5a".repeat(20)}`;
  const on = (automaticReturn: boolean) => { const base = testConfig(); return { get value() { return { ...base.value, copy: { mode: "testnet" as const, workerIntervalMs: 2000,
    agent: { workerQuorumId: "worker-quorum" }, live: { automaticReturn } } } as never; } } as never; };
  let policy: { available: boolean; create: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn>; assertSigner: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    await db.update(users).set({ embeddedWalletAddress: main }).where(eq(users.id, uid));
    policy = { available: true, create: vi.fn(async () => ({ id: "policy-1" })), verify: vi.fn(async () => ({ id: "policy-1", ownerQuorumId: "q", fingerprint: "d".repeat(64) })),
      assertSigner: vi.fn(async () => undefined) };
  });
  const ready = async () => (await service.prepare(uid, strategy, { network: "testnet" })).id;

  it("is off unless the deployment turns it on, and never touches Privy then", async () => {
    const id = await ready();
    const off = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), on(false), provider, policy as never);
    await expect(off.enableAutomaticReturn(uid, id)).rejects.toMatchObject({ response: expect.objectContaining({ code: "setup_unavailable" }) });
    expect(policy.create).not.toHaveBeenCalled();
  });

  it("creates the owner's policy for the main wallet, verifies the signer Privy shows, records it once", async () => {
    const id = await ready();
    const before = (await db.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, id)))[0]!.revision;
    const enabled = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), on(true), provider, policy as never);
    expect(await enabled.enableAutomaticReturn(uid, id)).toMatchObject({ id, state: "ready", automaticReturn: true });
    expect(policy.create).toHaveBeenCalledWith("did:privy:wallet-owner", { ownerMain: main, account: addr }, `master_${id.replaceAll("-", "")}`);
    expect(policy.assertSigner).toHaveBeenCalledWith("provider-wallet", { address: addr, ownerQuorumId: "verified-user-quorum", workerQuorumId: "worker-quorum", policyId: "policy-1" });
    const [row] = await db.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, id));
    expect(row).toMatchObject({ masterPolicyId: "policy-1", masterSignerQuorumId: "worker-quorum", sweepDestination: main, revision: before });
    // Identity is unchanged: consents bound to the account revision stay valid.
    // Again: nothing more at Privy; and reconcile now expects exactly that signer.
    await enabled.enableAutomaticReturn(uid, id);
    expect(policy.create).toHaveBeenCalledTimes(1);
    await enabled.reconcile(uid, id);
    expect(provider.findOwned).toHaveBeenLastCalledWith("did:privy:wallet-owner", row!.externalId, { workerQuorumId: "worker-quorum", policyId: "policy-1" });
  });

  it("records nothing while Privy doesn't show the signer, and answers without provider detail", async () => {
    const id = await ready();
    policy.assertSigner.mockRejectedValue(new Error("privy says no: did:privy:wallet-owner"));
    const enabled = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), on(true), provider, policy as never);
    const error = await enabled.enableAutomaticReturn(uid, id).catch((e: { response: unknown }) => e.response);
    expect(error).toEqual({ statusCode: 503, code: "setup_unavailable", message: "Automatic return could not be set up; try again" });
    expect((await db.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, id)))[0]!.masterPolicyId).toBeNull();
  });

  it("until the owner's browser adds the signer: 409 automatic_return_signer_missing with what to add; once added, recorded", async () => {
    const id = await ready();
    policy.assertSigner.mockRejectedValueOnce(new MasterPolicyConflict());
    const enabled = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), on(true), provider, policy as never);
    const error = await enabled.enableAutomaticReturn(uid, id).catch((e: { response: unknown }) => e.response);
    expect(error).toMatchObject({ statusCode: 409, code: "automatic_return_signer_missing", workerQuorumId: "worker-quorum", policyId: "policy-1" });
    expect((await db.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, id)))[0]!.masterPolicyId).toBeNull();
    expect(await enabled.enableAutomaticReturn(uid, id)).toMatchObject({ automaticReturn: true });
  });

  it("a setup's policy is created only while the automatic return is on (no orphan policies at Privy)", async () => {
    const id = await ready();
    const agent = { address: `0x${"33".repeat(20)}`, name: "copy1 valid_until 1" };
    const off = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), on(false), provider, policy as never);
    expect(await off.prepareSetupPolicy(uid, id, agent, "master_setup_x")).toBeNull();
    expect(policy.create).not.toHaveBeenCalled();
    const enabled = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), on(true), provider, policy as never);
    expect(await enabled.prepareSetupPolicy(uid, id, agent, "master_setup_x")).toEqual({ id: "policy-1", fingerprint: "d".repeat(64) });
    expect(policy.create).toHaveBeenCalledWith("did:privy:wallet-owner", { ownerMain: main, account: addr, agent }, "master_setup_x");
  });

  it("adopts the signer the browser added for a setup whose confirm never arrived (a closed tab), instead of blocking the wallet", async () => {
    const id = await ready();
    const [account] = await db.select().from(copyExecutionAccounts).where(eq(copyExecutionAccounts.id, id));
    await db.insert(copyLiveSetups).values({ id: "6d1f8c52-6d0e-4c43-9d8e-0d6f3c2f8a11", userId: uid, strategyId: strategy, accountId: id, kind: "start", idempotencyKey: "adopt-setup-key-000001",
      leaderAddress: addr, sourceNetwork: "mainnet", budgetUsd: "100", settings: {}, stage: "awaiting_consent",
      intent: { masterPolicyId: "policy-1", masterPolicyFingerprint: "d".repeat(64), agentAddress: `0x${"33".repeat(20)}`, strategyId: strategy, agentValidUntil: 1_800_000_000_000 } });
    // Privy shows a signer the account doesn't record: a conflict for the plain lookup.
    vi.mocked(provider.findOwned).mockImplementation(async (_user, _external, expected) => { if (!expected) throw new ProvisioningWalletConflict("wallet_conflict"); return stored; });
    const enabled = new CopyWalletService(new CopyWalletRepository(db), new UnitOfWork(db), on(true), provider, policy as never);
    expect(await enabled.reconcile(uid, id)).toMatchObject({ state: "ready", automaticReturn: true });
    expect(policy.verify).toHaveBeenCalledWith("policy-1", "did:privy:wallet-owner", { ownerMain: main, account: account!.address, agent: { address: `0x${"33".repeat(20)}`, name: `copy${strategy} valid_until 1800000000000` } });
    expect(policy.assertSigner).toHaveBeenCalledWith("provider-wallet", { address: addr, ownerQuorumId: "verified-user-quorum", workerQuorumId: "worker-quorum", policyId: "policy-1" });
    // Another signer than the setup's policy: still a conflict, the wallet blocked as before.
    await db.update(copyExecutionAccounts).set({ masterPolicyId: null, masterPolicyFingerprint: null, masterSignerQuorumId: null, sweepDestination: null, signerAttachedAt: null }).where(eq(copyExecutionAccounts.id, id));
    policy.assertSigner.mockRejectedValue(new MasterPolicyConflict());
    expect(await enabled.reconcile(uid, id)).toMatchObject({ state: "blocked" });
  });
});
