import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { copyExecutionAccounts, copyFollowerObservations, copyFollowerObservationJobs, copyFollowerObservationBudget, copyFollowerAccountState, copyStrategies, users } from '@trading-dashboard/shared/database';
import { CopyFollowerSnapshotRepository } from '../src/copy/copy-follower-snapshot.repository.js';
import { CopyFollowerSnapshotService, CopyFollowerSnapshotCollector } from '../src/copy/copy-follower-snapshot.service.js';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import type { LiveAccountSnapshot } from '../src/copy/live/live-account-observer.js';
import { fixture, now, account } from './copy-live-risk-test-utils.js';
import { testConfig } from './config-test-utils.js';
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from './db-test-utils.js';

let db: TestDb, repository: CopyFollowerSnapshotRepository, service: CopyFollowerSnapshotService, userId: number;
const snapshot = (): LiveAccountSnapshot => structuredClone(fixture().accountSource.snapshot);
beforeAll(() => { db = getTestDb(); repository = new CopyFollowerSnapshotRepository(db, testConfig()); service = new CopyFollowerSnapshotService(repository); });
beforeEach(async () => {
  await truncateAll(db); await db.delete(copyFollowerObservationBudget); vi.spyOn(Date, 'now').mockReturnValue(now);
  const user = await insertUser(db); userId = user.id;
  await db.insert(copyStrategies).values({ id: 9, userId, leaderAddress: `0x${'44'.repeat(20)}`, mode: 'testnet', status: 'paused', allocated: '0', cash: '0', activatedAt: new Date(now) });
  await db.insert(copyExecutionAccounts).values({ id: 'account', userId, strategyId: 9, network: 'testnet', state: 'ready', address: account, privyUserId: user.privyUserId, externalId: 'snapshot-fixture', privyWalletId: 'master', ownerQuorumId: 'owner' });
});
afterEach(() => vi.restoreAllMocks()); afterAll(closeTestDb);
async function store() { const claim = await repository.claim(); expect(claim).not.toBeNull(); await repository.save(claim!, snapshot()); return claim!; }
describe('actual follower acquisition, isolation and retained observations', () => {
  it('returns unknown before first observation and never uses zero paper cash as account equity', async () => {
    expect(await service.get(userId, 'account')).toMatchObject({ mode: 'actual', network: 'testnet', status: 'unavailable', reason: 'not_observed', observation: null });
    expect(await db.select().from(copyFollowerObservations)).toHaveLength(0);
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
