import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { copyExecutionAccounts, copyFundingOperations, copyFollowerObservations, copyFollowerObservationJobs, copyFollowerObservationBudget, copyFollowerAccountState, copyStrategies, copyLiveSetups, copyLiveMandates, copyLiveDispatches, copyLiveExecutions, users } from '@trading-dashboard/shared/database';
import { CopyFollowerSnapshotRepository } from '../src/copy/copy-follower-snapshot.repository.js';
import { CopyFollowerSnapshotService, CopyFollowerSnapshotCollector } from '../src/copy/copy-follower-snapshot.service.js';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import type { LiveAccountSnapshot } from '../src/copy/live/live-account-observer.js';
import { fixture, now, account } from './copy-live-risk-test-utils.js';
import { testConfig } from './config-test-utils.js';
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from './db-test-utils.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';

let db: TestDb, repository: CopyFollowerSnapshotRepository, service: CopyFollowerSnapshotService, userId: number;
const snapshot = (): LiveAccountSnapshot => structuredClone(fixture().accountSource.snapshot);
beforeAll(() => { db = getTestDb(); repository = new CopyFollowerSnapshotRepository(db, testConfig()); service = new CopyFollowerSnapshotService(repository); });
beforeEach(async () => {
  await truncateAll(db); await db.delete(copyFollowerObservationBudget); vi.spyOn(Date, 'now').mockReturnValue(now);
  const user = await insertUser(db); userId = user.id;
  await db.insert(copyStrategies).values({ id: 9, userId, leaderAddress: `0x${'44'.repeat(20)}`, mode: 'testnet', status: 'paused', allocated: '0', cash: '0', activatedAt: new Date(now) });
  await db.insert(copyExecutionAccounts).values({ id: 'account', userId, strategyId: 9, network: 'testnet', state: 'ready', address: account, privyUserId: user.privyUserId, externalId: 'snapshot-fixture', privyWalletId: 'master', ownerQuorumId: 'owner' });  // A credited deposit: the account may hold funds, so it is observed.
  await db.insert(copyFundingOperations).values({ id: 'deposit', userId, accountId: 'account', strategyId: 9, idempotencyKey: 'snapshot-deposit-key', network: 'testnet',
    address: `0x${'66'.repeat(20)}`, destination: account, amount: '50', nonce: now, status: 'credited', evidenceHash: 'e'.repeat(64), transactionHash: `0x${'e'.repeat(64)}`, creditedAmount: '49', fee: '1' });
});
afterEach(() => vi.restoreAllMocks()); afterAll(closeTestDb);
async function store() { const claim = await repository.claim(); expect(claim).not.toBeNull(); await repository.save(claim!, snapshot()); return claim!; }
describe('actual follower acquisition, isolation and retained observations', () => {
  it.each([
    { state: 'pending', network: 'testnet', stalled: false }, { state: 'submitted', network: 'testnet', stalled: false },
    { state: 'pending', network: 'mainnet', stalled: false },
    { state: 'pending', network: 'testnet', stalled: true }, { state: 'submitted', network: 'testnet', stalled: true },
  ] as const)('isolates reporting from $state work on $network, stalled=$stalled, without starving retained accounts', async ({ state, network, stalled }) => {
    const seed = await preparationFixture(db);
    const [owner] = await db.select().from(users).where(eq(users.id, 1));
    await db.insert(copyStrategies).values({ id: 10, userId: 1, leaderAddress: `0x${'44'.repeat(20)}`, mode: 'testnet', status: 'stopped', allocated: '0', cash: '0', activatedAt: new Date(now), stoppedAt: new Date(now + 1) });
    await db.insert(copyExecutionAccounts).values({ id: 'residual-account', userId: 1, strategyId: 10, network: 'testnet', state: 'ready',
      address: `0x${'77'.repeat(20)}`, privyUserId: owner!.privyUserId, externalId: 'retained-snapshot-fixture', privyWalletId: 'residual-master', ownerQuorumId: 'owner' });
    await db.insert(copyFundingOperations).values({ id: 'residual-deposit', userId: 1, accountId: 'residual-account', strategyId: 10,
      idempotencyKey: 'residual-snapshot-deposit-key', network: 'testnet', address: `0x${'66'.repeat(20)}`, destination: `0x${'77'.repeat(20)}`,
      amount: '50', nonce: now, status: 'credited', evidenceHash: 'e'.repeat(64), transactionHash: `0x${'e'.repeat(64)}`, creditedAmount: '49', fee: '1' });
    await db.insert(copyFollowerObservationJobs).values({ accountId: 'residual-account', nextRunAt: sql`clock_timestamp() - interval '60 seconds'` });
    if (state === 'submitted') await db.insert(copyLiveExecutions).values({ key: 'testnet:submitted-snapshot-order', network: 'testnet',
      accountAddress: account, signerAddress: `0x${'88'.repeat(20)}`, cloid: seed.f.intent.cloid, nonce: now, userId: 1, strategyId: 9,
      state: 'unknown', record: {}, updatedAt: new Date(now) });
    await db.insert(copyLiveDispatches).values({ id: 'active-dispatch', mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account',
      sourceFillId: seed.fill.id, leg: 'open', coin: 'BTC', state, executionKey: state === 'submitted' ? 'testnet:submitted-snapshot-order' : null, leaderTime: sql`clock_timestamp() - interval '1 second'`, receivedAt: new Date(now) });
    if (network === 'mainnet') {
      // A retained identity from another deployment network must not block testnet reporting.
      await db.update(copyExecutionAccounts).set({ network }).where(eq(copyExecutionAccounts.id, 'account'));
      expect(await repository.claim()).toMatchObject({ accountId: 'residual-account' });
      return;
    }
    expect(await repository.claim()).toBeNull();
    expect((await db.select().from(copyFollowerObservationJobs).where(eq(copyFollowerObservationJobs.accountId, 'residual-account')))[0]!.claimToken).toBeNull();
    if (stalled) {
      if (state === 'pending') {
        await db.update(copyLiveMandates).set({ state: 'paused' });
        await db.update(copyLiveDispatches).set({ leg: 'close' });
      }
      await db.update(copyFollowerObservationBudget).set({ nextAllowedAt: sql`clock_timestamp() - interval '1 second'`, nextSnapshotAllowedAt: sql`clock_timestamp() - interval '1 second'` });
      expect(await repository.claim()).toMatchObject({ accountId: 'residual-account' });
      expect((await db.select().from(copyLiveDispatches))[0]!.state).toBe(state);
      return;
    }
    await db.update(copyLiveDispatches).set({ state: 'refused', reason: 'platform_paused' });
    expect(await repository.claim()).toMatchObject({ accountId: 'residual-account' });
  });
  it('does not replace a newer observation with an older in-flight provider result', async () => {
    const claim = await repository.claim(); expect(claim).not.toBeNull();
    const older = snapshot(), newer = snapshot() as { -readonly [K in keyof LiveAccountSnapshot]: LiveAccountSnapshot[K] };
    newer.observedAt += 1000; newer.completedAt += 1000;
    newer.coverage = { ...newer.coverage, earliestProviderTime: newer.coverage.earliestProviderTime + 1000 };
    newer.dexes = newer.dexes.map(d => ({ ...d, providerTime: d.providerTime + 1000 }));
    newer.sourceDigest = 'b'.repeat(64);
    vi.mocked(Date.now).mockReturnValue(now + 1000);
    expect(await repository.save(claim!, newer)).toBe(true);
    expect(await repository.save(claim!, older)).toBe(false);
    expect(await service.get(userId, 'account')).toMatchObject({ status: 'observed', sourceDigest: newer.sourceDigest,
      asOf: { observedAt: now + 1000, completedAt: now + 1000, earliestProviderTime: now + 1000 } });
  });

  it('defers a funded setup still acquiring its live capabilities, but retains funds after it fails', async () => {
    await db.insert(copyLiveSetups).values({ id: 'new-setup', userId, strategyId: 9, accountId: 'account', kind: 'start',
      idempotencyKey: 'new-snapshot-setup-0001', stage: 'awaiting_consent', leaderAddress: `0x${'44'.repeat(20)}`,
      sourceNetwork: 'testnet', budgetUsd: '50', settings: {} });
    expect(await repository.claim()).toBeNull();
    await db.update(copyLiveSetups).set({ stage: 'failed' });
    expect(await repository.claim()).toMatchObject({ accountId: 'account' });
  });
  it('gives a newly active copy time for its first dispatch without hiding an idle funded account indefinitely', async () => {
    await preparationFixture(db);
    await db.update(copyLiveMandates).set({ createdAt: sql`statement_timestamp()`, activationCursor: sql`statement_timestamp()`,
      nonce: sql`floor(extract(epoch from statement_timestamp()) * 1000)`, consentExpiresAt: sql`statement_timestamp() + interval '30 seconds'`,
      expiresAt: sql`statement_timestamp() + interval '1 day'`, updatedAt: sql`statement_timestamp()` });
    expect(await repository.claim()).toBeNull();
    await db.update(copyLiveMandates).set({ createdAt: sql`clock_timestamp() - interval '121 seconds'` });
    expect(await repository.claim()).toMatchObject({ accountId: 'account' });
  });
  it('defers reporting while a financial dispatch is pending and resumes after its terminal refusal', async () => {
    const seed = await preparationFixture(db);
    await db.insert(copyLiveDispatches).values({ id: 'pending-dispatch', mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account',
      sourceFillId: seed.fill.id, leg: 'open', coin: 'BTC', state: 'pending', leaderTime: sql`clock_timestamp() - interval '1 second'`, receivedAt: new Date(now) });
    expect(await repository.claim()).toBeNull();
    await db.update(copyLiveDispatches).set({ state: 'refused', reason: 'test_refusal' });
    expect(await repository.claim()).toMatchObject({ accountId: 'account' });
  });
  it('returns unknown before first observation and never uses zero paper cash as account equity', async () => {
    expect(await service.get(userId, 'account')).toMatchObject({ mode: 'actual', network: 'testnet', status: 'unavailable', reason: 'not_observed', observation: null });
    expect(await db.select().from(copyFollowerObservations)).toHaveLength(0);
  });
  it('observes only accounts that may hold funds or run a copy (a setup that ended before its deposit was observed every two minutes)', async () => {
    await db.delete(copyFundingOperations);
    expect(await repository.claim()).toBeNull();
    // A deposit sent (not yet credited) is enough.
    await db.insert(copyFundingOperations).values({ id: 'sent', userId, accountId: 'account', strategyId: 9, idempotencyKey: 'snapshot-sent-key', network: 'testnet',
      address: `0x${'66'.repeat(20)}`, destination: account, amount: '50', nonce: now + 1, status: 'accepted', evidenceHash: 'f'.repeat(64) });
    await db.delete(copyFollowerObservationBudget);
    await store();
    // Its latest observation shows it empty (returned after a stop): no more reads.
    await db.execute(sql`update copy_follower_observations set snapshot = jsonb_set(snapshot, '{perpEquity}', '"0"')`);
    await db.update(copyFollowerObservationJobs).set({ nextRunAt: new Date(0), claimToken: null, attemptedAt: null }); await db.delete(copyFollowerObservationBudget);
    expect(await repository.claim()).toBeNull();
  });
  it('admits one acquisition across concurrent repository instances and preserves allowance after a restart', async () => {
    const claims = await Promise.all(Array.from({ length: 8 }, () => new CopyFollowerSnapshotRepository(db, testConfig()).claim()));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await new CopyFollowerSnapshotRepository(db, testConfig()).claim()).toBeNull();
    await repository.issue(claims.find(Boolean)!, 'source_unavailable');
    expect(await repository.claim()).toBeNull();
  });
  it('persists actual evidence once and repeated GETs preserve its original source timestamps', async () => {
    const claim = await store(); expect(await repository.save(claim, snapshot())).toBe(true);
    const first = await service.get(userId, 'account');
    expect(first).toMatchObject({ status: 'observed', freshness: 'fresh', lastReadIssue: null, metrics: { perpEquity: '100', roi: null, periodPnl: null, netDeposits: null }, asOf: { observedAt: now, completedAt: now } });
    vi.mocked(Date.now).mockReturnValue(now + 6000);
    expect(await service.get(userId, 'account')).toMatchObject({ status: 'observed', freshness: 'stale', asOf: { observedAt: now, completedAt: now } });
    expect(await db.select().from(copyFollowerObservations)).toHaveLength(1);
  });
  it('retains old explicitly stale observations when refresh fails', async () => {
    const claim = await store(); await repository.issue(claim, 'source_unavailable');
    expect(await service.get(userId, 'account')).toMatchObject({ status: 'observed', freshness: 'stale', lastReadIssue: 'source_unavailable', metrics: { perpEquity: '100' } });
  });
  it('keeps disabled/stopped/revoked account observations, while refusing disabled-owner HTTP reads', async () => {
    await db.update(copyStrategies).set({ status: 'stopped', stoppedAt: new Date() }).where(eq(copyStrategies.id, 9));
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));
    await store(); expect(await db.select().from(copyFollowerObservations)).toHaveLength(1);
    await expect(service.get(userId, 'account')).rejects.toThrow('Execution account not found');
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, userId));
    await db.insert(copyFollowerAccountState).values({ accountId: 'account', quarantined: true, reason: 'follower_unattributed_trade' });
    expect(await service.get(userId, 'account')).toMatchObject({ status: 'observed', quarantine: { blocked: true, reason: 'follower_unattributed_trade' } });
  });
  it('rejects master revision changes during provider waits without publishing old evidence', async () => {
    const claim = (await repository.claim())!;
    await db.update(copyExecutionAccounts).set({ revision: 2 }).where(eq(copyExecutionAccounts.id, 'account'));
    await expect(repository.save(claim, snapshot())).rejects.toThrow('follower_account_identity_changed');
    expect(await db.select().from(copyFollowerObservations)).toHaveLength(0);
  });
  it('rejects changed normalized content under the same immutable digest', async () => {
    const claim = await store(), changed = structuredClone(snapshot());
    const mutated = { ...changed, perpEquity: '101', withdrawable: '101', dexes: [{ ...changed.dexes[0]!, equity: '101', withdrawable: '101', rawUsd: '101', crossEquity: '101' }] };
    await expect(repository.save(claim, mutated)).rejects.toThrow('follower_snapshot_identity_mismatch');
    expect((await db.select().from(copyFollowerObservations))[0]!.snapshot.perpEquity).toBe('100');
  });
  it('refuses stale claim tokens, cross-owner reads and detached Privy identities', async () => {
    const claim = (await repository.claim())!;
    expect(await repository.save({ ...claim, claimToken: 'replaced' }, snapshot())).toBe(false);
    const other = await insertUser(db); await expect(service.get(other.id, 'account')).rejects.toThrow('Execution account not found');
    await db.update(users).set({ privyUserId: 'did:privy:changed' }).where(eq(users.id, userId));
    await expect(service.get(userId, 'account')).rejects.toThrow('Execution account not found');
  });
  it('does not label a mainnet master with testnet observations', async () => {
    await db.update(copyExecutionAccounts).set({ network: 'mainnet' }).where(eq(copyExecutionAccounts.id, 'account'));
    expect(await repository.claim()).toBeNull();
    // Its own (mainnet) observations only: none, so nothing is shown as observed.
    expect(await service.get(userId, 'account')).toMatchObject({ network: 'mainnet', status: 'unavailable', observation: null });
  });
  it('performs provider work outside transactions and rechecks ownership before publishing', async () => {
    let enter!: () => void, release!: (value: LiveAccountSnapshot) => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const provider = { observe: vi.fn(async () => { enter(); return new Promise<LiveAccountSnapshot>(resolve => { release = resolve; }); }) };
    const collector = new CopyFollowerSnapshotCollector(repository, provider, testConfig(), new BackgroundJobs());
    const work = collector.runOnce(); await entered;
    await db.transaction(async tx => {
      const unlocked = await tx.execute<{ held: boolean }>(sql`select pg_try_advisory_xact_lock(7404,${userId}) as held`);
      expect(unlocked.rows[0]?.held).toBe(true);
      await tx.update(copyExecutionAccounts).set({ revision: 2 }).where(eq(copyExecutionAccounts.id, 'account'));
    });
    release(snapshot()); await work;
    expect(provider.observe).toHaveBeenCalledTimes(1); expect(await db.select().from(copyFollowerObservations)).toHaveLength(0);
    expect((await db.select().from(copyFollowerObservationJobs))[0]!.issue).toBe('invalid_evidence');
  });
});
