import { exchangeApprovalFixture, executionGateFixture } from "./copy-live-test-utils.js";
import { Pool } from "pg";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { copyAgentSetups, copyExecutionAccounts, copyExecutionWallets, copyLiveExecutions, copyStrategies, copyWalletAuthorizations, users } from "@trading-dashboard/shared/database";
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from "./db-test-utils.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import { PostgresLiveExecutionJournal } from "../src/copy/live/postgres-live-journal.js";
import { ScopedLiveExecutionJournal } from '../src/copy/live/scoped-live-journal.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { PostgresWalletAuthorizationSource } from "../src/copy/live/postgres-wallet-authorizations.js";
import { LiveOrderExecutor, type LiveExchangeTransport } from "../src/copy/live/live-execution.js";
import { buildOrderAction, executionKey, intentFingerprint, type LiveOrderIntent } from "../src/copy/live/live-order.js";
import { WalletAuthorizationService, type WalletAuthorization } from "../src/copy/live/wallet-authorization.js";

const gate = executionGateFixture();
const now = 1_790_000_000_000;
let db: TestDb;
let lockPool: Pool;
let grant: WalletAuthorization;
let intent: LiveOrderIntent;
let first: PostgresLiveExecutionJournal;
let second: PostgresLiveExecutionJournal;

beforeAll(() => {
  // getTestDb validates loopback host and _test database before another pool is opened.
  db = getTestDb();
  lockPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  first = new PostgresLiveExecutionJournal(db, lockPool, new UnitOfWork(db));
  second = new PostgresLiveExecutionJournal(db, lockPool, new UnitOfWork(db));
});
beforeEach(async () => {
  await truncateAll(db);
  // Nonce state has no FK and deliberately survives account deletion in production.
  await db.execute(sql`truncate table copy_signer_nonces`);
  const user = await insertUser(db);
  grant = { id: "grant", version: 1, userId: user.id, strategyId: 2, walletId: "privy-wallet", privyOwnerId: "quorum",
    signerAddress: `0x${"11".repeat(20)}`, accountAddress: `0x${"22".repeat(20)}`, network: "testnet", scopes: ["copy:trade", "copy:reduce"],
    validFrom: now - 1, expiresAt: now + 100_000, revokedAt: null, exchangeApprovedAt: now - 1 };
  intent = { authorizationId: "grant", userId: user.id, strategyId: 2, walletId: "privy-wallet", network: "testnet",
    accountAddress: grant.accountAddress, reduceOnly: false, cloid: `0x${"ab".repeat(16)}`, asset: 0, side: "B", size: "0.01", limitPrice: "65000", sizeDecimals: 5, timeInForce: "Ioc" };
  await db.insert(copyStrategies).values({ id: grant.strategyId, userId: user.id, leaderAddress: `0x${"44".repeat(20)}`, allocated: "100", cash: "100", activatedAt: new Date(now) });
  await db.insert(copyExecutionAccounts).values({ id: "execution-account", userId: user.id, strategyId: grant.strategyId, network: grant.network,
    privyUserId: user.privyUserId!, externalId: "master-external", state: "ready", address: grant.accountAddress,
    privyWalletId: "master-wallet", ownerQuorumId: "master-owner" });
  await db.insert(copyExecutionWallets).values({ id: "execution-wallet", userId: user.id, strategyId: grant.strategyId, network: grant.network,
    accountAddress: grant.accountAddress, signerAddress: grant.signerAddress, privyWalletId: grant.walletId, privyOwnerId: grant.privyOwnerId });
  await db.insert(copyWalletAuthorizations).values({ id: grant.id, walletId: "execution-wallet", version: grant.version, scopes: [...grant.scopes],
    validFrom: new Date(grant.validFrom), expiresAt: new Date(grant.expiresAt), exchangeApprovedAt: new Date(grant.exchangeApprovedAt!) });
  await db.insert(copyAgentSetups).values({ id: "setup", userId: user.id, strategyId: grant.strategyId, accountId: "execution-account", network: grant.network,
    idempotencyKey: "journal-agent-setup", validForDays: 1, externalId: "agent-external", workerQuorumId: "worker-quorum", policyAttemptId: "policy-attempt",
    policyId: "agent-policy", policyFingerprint: "a".repeat(64), agentWalletId: grant.walletId, agentOwnerQuorumId: grant.privyOwnerId,
    agentAddress: grant.signerAddress, accountAddress: grant.accountAddress, accountWalletId: "master-wallet", accountOwnerQuorumId: "master-owner",
    state: "active", authorizationId: grant.id, expiresAt: new Date(grant.expiresAt), createdAt: new Date(now - 1), updatedAt: new Date(now) });

});
afterAll(async () => { await lockPool?.end(); await closeTestDb(); });

function input(order = intent, authorization = grant) {
  const action = buildOrderAction(order);
  return { key: executionKey(order), fingerprint: intentFingerprint(order, action), authorization, action, now };
}
function transport(): LiveExchangeTransport {
  return { network: "testnet",
    sign: vi.fn<LiveExchangeTransport["sign"]>(async (record) => ({ action: record.action, nonce: record.nonce, expiresAfter: record.expiresAfter,
      signature: { r: "0x01", s: "0x02", v: 27 } })),
    submit: vi.fn<LiveExchangeTransport["submit"]>(async () => { throw new Error("accepted then response lost"); }),
    query: vi.fn<LiveExchangeTransport["query"]>(async () => null) };
}

describe("live PostgreSQL journal and authorization authority", () => {
  it('reads and transitions the original prepared journal with a single-connection scoped pool', async () => {
    const original = await first.prepare(input());
    const scopedPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      await new PostgresLiveRiskScope(scopedPool, () => now).run({ userId: grant.userId, network: grant.network, accountAddress: grant.accountAddress }, async (_scope, session) => {
        const journal = new ScopedLiveExecutionJournal(session, original.key);
        await journal.withOrderLock(original.key, async lease => {
          expect(await journal.prepare(input())).toEqual(original);
          await journal.save({ ...original, state: 'submitting' });
          await lease.assertHeld();
          expect((await journal.get(original.key))?.state).toBe('submitting');
        });
      });
    } finally { await scopedPool.end(); }
  });
  it('cannot prepare an authority-free journal or allocate a fresh nonce through the scoped executor adapter', async () => {
    await new PostgresLiveRiskScope(lockPool, () => now).run({ userId: grant.userId, network: grant.network, accountAddress: grant.accountAddress }, async (_scope, session) => {
      const journal = new ScopedLiveExecutionJournal(session, executionKey(intent));
      await expect(journal.prepare(input())).rejects.toThrow('execution_record_missing');
    });
    expect(await db.select().from(copyLiveExecutions)).toHaveLength(0);
    expect((await db.execute(sql`select * from copy_signer_nonces`)).rows).toHaveLength(0);
  });
  it('tombstones scoped journal and order callbacks before a successor can use the same key', async () => {
    const original = await first.prepare(input()); let saved!: ScopedLiveExecutionJournal; let savedLease!: Parameters<Parameters<ScopedLiveExecutionJournal['withOrderLock']>[1]>[0];
    const scopes = new PostgresLiveRiskScope(lockPool, () => now), identity = { userId: grant.userId, network: grant.network, accountAddress: grant.accountAddress };
    await scopes.run(identity, async (_scope, session) => {
      saved = new ScopedLiveExecutionJournal(session, original.key);
      await saved.withOrderLock(original.key, async lease => { savedLease = lease; });
      await expect(savedLease.assertHeld()).rejects.toThrow('execution_lease_lost');
    });
    await scopes.run(identity, async () => { await expect(saved.get(original.key)).rejects.toThrow('live_risk_serialization_lost'); });
  });
  it('rejects foreign keys, changed authorization and immutable journal mutations on the original session', async () => {
    const original = await first.prepare(input());
    await new PostgresLiveRiskScope(lockPool, () => now).run({ userId: grant.userId, network: grant.network, accountAddress: grant.accountAddress }, async (_scope, session) => {
      const journal = new ScopedLiveExecutionJournal(session, original.key);
      await expect(journal.get('foreign')).rejects.toThrow('execution_record_scope_mismatch');
      await expect(journal.prepare(input(intent, { ...grant, version: 2 }))).rejects.toThrow('wallet_authorization_changed');
      await expect(journal.save({ ...original, action: { ...original.action, orders: [{ ...original.action.orders[0], s: '1' }] } })).rejects.toThrow('execution_record_immutable');
    });
    expect(await first.get(original.key)).toEqual(original);
  });
  it('persists indexed market evidence immutably and compares retries by identity', async () => {
    const market = { network: 'testnet' as const, coin: 'xyz:TSLA', dex: 'xyz', asset: 130000,
      universeIndex: 0, perpDexIndex: 3, sizeDecimals: 3, maxLeverage: 10, observedAt: now };
    const liveIntent = { ...intent, asset: 130000, sizeDecimals: 3, market };
    const preparedInput = { ...input(liveIntent), market };
    const prepared = await first.prepare(preparedInput);
    expect((await second.get(prepared.key))?.market).toEqual(market);
    await expect(second.save({ ...prepared, market: { ...market, coin: 'xyz:ETH' } })).rejects.toThrow('execution_record_immutable');
    const newer = { ...market, observedAt: now + 1, maxLeverage: 5 };
    expect(await second.prepare({ ...preparedInput, market: newer })).toEqual(prepared);
  });
  it("allocates unique monotonic nonces for two instances sharing signer and clock", async () => {
    const other = { ...intent, cloid: `0x${"cd".repeat(16)}` as const };
    const [a, b] = await Promise.all([first.prepare(input()), second.prepare(input(other))]);
    expect([a.nonce, b.nonce].sort()).toEqual([now, now + 1]);
    const restarted = new PostgresLiveExecutionJournal(db, lockPool, new UnitOfWork(db));
    const c = await restarted.prepare(input({ ...intent, cloid: `0x${"ef".repeat(16)}` }));
    expect(c.nonce).toBe(now + 2);
    expect(c.expiresAfter).toBe(now + 60_000);
  });
  it("nonce scopes isolate networks and independent signers", async () => {
    const a = await first.prepare(input());
    const main = { ...intent, network: "mainnet" as const };
    const b = await second.prepare(input(main, { ...grant, network: "mainnet" }));
    const c = await second.prepare(input({ ...intent, cloid: `0x${"cd".repeat(16)}` }, { ...grant, signerAddress: `0x${"33".repeat(20)}` }));
    expect([a.nonce, b.nonce, c.nonce]).toEqual([now, now, now]);
  });
  it("persists timeout state across restart and reconciles original cloid without resubmitting", async () => {
    const auth = new WalletAuthorizationService(new PostgresWalletAuthorizationSource(db), exchangeApprovalFixture(() => now), () => now);
    const exchange = transport();
    const initial = new LiveOrderExecutor(auth, first, exchange, gate, () => now);
    expect((await initial.execute(intent)).state).toBe("unknown");
    expect((await second.get(executionKey(intent)))?.errorCode).toBe("exchange_submission_ambiguous");
    const resumedExchange = transport();
    const resumed = new LiveOrderExecutor(auth, second, resumedExchange, gate, () => now);
    expect((await resumed.execute(intent)).state).toBe("unknown");
    expect(resumedExchange.query).toHaveBeenCalledWith(expect.objectContaining({ action: buildOrderAction(intent), nonce: now }));
    expect(resumedExchange.sign).not.toHaveBeenCalled();
    expect(resumedExchange.submit).not.toHaveBeenCalled();
    vi.mocked(resumedExchange.query).mockResolvedValue({ state: "filled", exchangeOrderId: "123", filledSize: "0.01" });
    expect((await resumed.execute(intent)).state).toBe("filled");
    expect((await first.get(executionKey(intent)))?.outcome?.exchangeOrderId).toBe("123");
  });
  it("same cloid preserves payload and nonce; conflict does not burn another nonce", async () => {
    const original = await first.prepare(input());
    expect(await second.prepare(input())).toEqual(original);
    await expect(second.prepare(input({ ...intent, size: "0.02" }))).rejects.toThrow("cloid_payload_conflict");
    const next = await second.prepare(input({ ...intent, cloid: `0x${"cd".repeat(16)}` }));
    expect(next.nonce).toBe(now + 1);
  });
  it("same cloid preparation across rotated signers creates only one durable intent", async () => {
    const rotated = { ...grant, version: 2, signerAddress: `0x${"33".repeat(20)}` as const };
    const [a, b] = await Promise.all([first.prepare(input()), second.prepare(input(intent, rotated))]);
    expect(a).toEqual(b);
    const rows = await db.select().from(copyLiveExecutions);
    expect(rows).toHaveLength(1);
  });
  it("distributed session lock denies a second owner and releases after failures", async () => {
    const key = executionKey(intent);
    let unlock!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { unlock = resolve; });
    const pending = first.withOrderLock(key, async () => { entered(); await hold; throw new Error("worker failed"); });
    // Attach rejection observer before releasing, avoiding unhandled promise rejection.
    const finished = expect(pending).rejects.toThrow("worker failed");
    await ready;
    try {
      await expect(second.withOrderLock(key, async () => "unsafe second owner")).rejects.toThrow("execution_busy");
    } finally { unlock(); }
    await finished;
    expect(await second.withOrderLock(key, async () => "new owner")).toBe("new owner");
  });
  it("checks the original session lock and refuses a released lease", async () => {
    const client = await lockPool.connect();
    const connect = vi.spyOn(lockPool, "connect").mockResolvedValueOnce(client as never);
    try {
      await first.withOrderLock(executionKey(intent), async (lease) => {
        await lease.assertHeld();
        await client.query("select pg_advisory_unlock_all()");
        await expect(lease.assertHeld()).rejects.toThrow("execution_lease_lost");
      });
    } finally { connect.mockRestore(); }
  });
  it("rejects immutable payload edits and backwards terminal transitions", async () => {
    const prepared = await first.prepare(input());
    await expect(first.save({ ...prepared, nonce: prepared.nonce + 1 })).rejects.toThrow("execution_record_immutable");
    const submitting = { ...prepared, state: "submitting" as const };
    await first.save(submitting);
    const filled = { ...submitting, state: "filled" as const, outcome: { state: "filled" as const, exchangeOrderId: "123" } };
    await second.save(filled);
    await first.save({ ...filled, errorCode: undefined }); // JSONB-normalized idempotent retry
    await expect(first.save({ ...prepared, updatedAt: now + 1 })).rejects.toThrow("execution_state_transition_denied");
    expect((await second.get(prepared.key))?.state).toBe("filled");
  });
  it("rejects mismatched persisted columns and JSON evidence", async () => {
    const prepared = await first.prepare(input());
    await db.update(copyLiveExecutions).set({ record: { ...prepared, nonce: now + 1 } as unknown as Record<string, unknown> }).where(eq(copyLiveExecutions.key, prepared.key));
    await expect(second.get(prepared.key)).rejects.toThrow("execution_record_invalid");
  });
  it("source sees committed revocation immediately and enforces network binding", async () => {
    const source = new PostgresWalletAuthorizationSource(db);
    const auth = new WalletAuthorizationService(source, exchangeApprovalFixture(() => now), () => now);
    expect(await auth.authorize(intent)).toEqual(grant);
    await expect(auth.authorize({ ...intent, network: "mainnet" })).rejects.toThrow("wallet_network_mismatch");
    await db.update(copyWalletAuthorizations).set({ revokedAt: new Date(now), version: 2 }).where(eq(copyWalletAuthorizations.id, grant.id));
    expect((await source.find(grant.id))?.version).toBe(2);
    await expect(auth.authorize(intent)).rejects.toThrow("wallet_authorization_revoked");
  });
  it.each(["account_pending", "privy_owner_changed", "setup_revoked", "agent_detached", "master_detached", "strategy_owner_changed"] as const)("refuses an unrevoked grant after %s", async change => {
    const source = new PostgresWalletAuthorizationSource(db);
    expect(await source.find(grant.id)).toEqual(grant);
    if (change === "account_pending") await db.update(copyExecutionAccounts).set({ state: "unknown", issue: "verification_pending" });
    if (change === "privy_owner_changed") await db.update(users).set({ privyUserId: "did:privy:replacement-owner" }).where(eq(users.id, grant.userId));
    if (change === "setup_revoked") await db.update(copyAgentSetups).set({ state: "revoked" });
    if (change === "agent_detached") await db.update(copyAgentSetups).set({ agentWalletId: "different-agent" });
    if (change === "master_detached") await db.update(copyAgentSetups).set({ accountWalletId: "different-master" });
    if (change === "strategy_owner_changed") {
      const other = await insertUser(db);
      await db.update(copyStrategies).set({ userId: other.id });
    }
    expect(await source.find(grant.id)).toBeNull();
  });
  it("disabled owner cannot obtain an authorization even with an unrevoked grant", async () => {
    const auth = new WalletAuthorizationService(new PostgresWalletAuthorizationSource(db), exchangeApprovalFixture(() => now), () => now);
    await auth.authorize(intent);
    await db.update(users).set({ disabledAt: new Date(now) }).where(eq(users.id, grant.userId));
    await expect(auth.authorize(intent)).rejects.toThrow();
  });
});
