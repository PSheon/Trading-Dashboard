import { setTimeout as realDelay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { copyExecutionAccounts, copyFundingOperations, copyFollowerObservationBudget, copyFollowerObservationJobs, copyFollowerObservations, copyLiveDispatches, copyStrategies } from '@trading-dashboard/shared/database';
import { CopyFollowerSnapshotRepository } from '../src/copy/copy-follower-snapshot.repository.js';
import { CopyFollowerSnapshotCollector } from '../src/copy/copy-follower-snapshot.service.js';
import { followerSnapshotReader } from '../src/copy/copy-worker.module.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import type { WalletNetworkHyperliquid } from '../src/copy/copy.module.js';
import { fixture } from './copy-live-risk-test-utils.js';
import type { AppConfig } from '../src/config/app-config.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { testConfig } from './config-test-utils.js';
import { getTestDb, closeTestDb, type TestDb } from './db-test-utils.js';

let db: TestDb, repository: CopyFollowerSnapshotRepository, seed: Awaited<ReturnType<typeof preparationFixture>>;
let budget: RequestBudgeterService | undefined;
const originals = { rate: process.env.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN, burst: process.env.HYPERLIQUID_WEIGHT_BURST, pace: process.env.HYPERLIQUID_STARTUP_PACE_SECONDS };
beforeAll(() => { db = getTestDb(); });
beforeEach(async () => {
  seed = await preparationFixture(db);
  repository = new CopyFollowerSnapshotRepository(db, testConfig());
  await db.delete(copyFollowerObservationBudget);
  await db.insert(copyStrategies).values({ id: 10, userId: 1, mode: 'testnet', status: 'stopped', leaderAddress: `0x${'44'.repeat(20)}`, allocated: '0', cash: '0', activatedAt: new Date(), stoppedAt: new Date() });
  await db.insert(copyExecutionAccounts).values({ id: 'residual', userId: 1, strategyId: 10, network: 'testnet', state: 'ready', address: `0x${'77'.repeat(20)}`, privyUserId: 'did:privy:risk-source', externalId: 'retained-queue', privyWalletId: 'retained-master', ownerQuorumId: 'owner' });
  await db.insert(copyFundingOperations).values({ id: 'deposit', userId: 1, accountId: 'residual', strategyId: 10, idempotencyKey: 'retained-queue-deposit', network: 'testnet', address: `0x${'55'.repeat(20)}`, destination: `0x${'77'.repeat(20)}`, amount: '50', nonce: Date.now(), status: 'credited', evidenceHash: 'e'.repeat(64), transactionHash: `0x${'e'.repeat(64)}`, creditedAmount: '50', fee: '0' });
  await db.insert(copyFollowerObservationJobs).values({ accountId: 'residual', nextRunAt: sql`clock_timestamp() - interval '600 seconds'` });
  process.env.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN = '400'; process.env.HYPERLIQUID_WEIGHT_BURST = '800'; process.env.HYPERLIQUID_STARTUP_PACE_SECONDS = '0';
});
afterEach(() => { budget?.onModuleDestroy(); budget = undefined; vi.useRealTimers(); vi.restoreAllMocks();
  for (const [key, value] of [['HYPERLIQUID_WEIGHT_BUDGET_PER_MIN', originals.rate], ['HYPERLIQUID_WEIGHT_BURST', originals.burst], ['HYPERLIQUID_STARTUP_PACE_SECONDS', originals.pace]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
afterAll(closeTestDb);
async function foreground() {
  await db.insert(copyLiveDispatches).values({ id: 'new-foreground', mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', sourceFillId: seed.fill.id, leg: 'open', coin: 'BTC', state: 'pending', leaderTime: sql`clock_timestamp()`, receivedAt: new Date() });
}
async function queuedReader(network: 'testnet' | 'mainnet' = 'testnet') {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  budget = new RequestBudgeterService(testConfig());
  await budget.acquire(800, 'live');
  let http = 0;
  const fetchInfo: typeof fetch = async () => { http++; return new Response('{}', { status: 503 }); };
  const transport = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(db)), { egressKey: 'snapshot-queue-test', ownerId: 'test-worker' }, fetchInfo);
  // Only the external transport boundary is replaced. Claim and local queue remain real.
  vi.spyOn(transport, 'fetchBackgroundInfo').mockImplementation(fetchInfo);
  const reader = followerSnapshotReader({ budget, network, transport } as Pick<WalletNetworkHyperliquid, 'budget' | 'network' | 'transport'>);
  return { reader, count: () => http };
}
async function waitQueued() { for (let i = 0; i < 200 && budget!.queued().background === 0; i++) await realDelay(5); expect(budget!.queued().background).toBe(1); }

it('keeps scheduled reporting out of the shared foreground reserve even when its local background credit is available', async () => {
  budget = new RequestBudgeterService(testConfig());
  const quota = new PostgresHyperliquidQuota(new UnitOfWork(db));
  const binding = { egressKey: 'snapshot-shared-background-test', ownerId: 'snapshot-worker' };
  // Background work has filled its shared lane; the remaining 360 is for
  // foreground reads. This deliberately leaves the local bucket available.
  await quota.bindUnscoped(binding).acquireRest(840, Date.now() + 5000);
  const http = vi.fn<typeof fetch>(async () => new Response('{}', { status: 503 }));
  const transport = new HyperliquidGlobalTransport(quota, binding, http);
  const reader = followerSnapshotReader({ budget, network: 'testnet', transport });
  try {
    await expect(reader.observe(`0x${'77'.repeat(20)}`)).rejects.toThrow();
    expect(http).not.toHaveBeenCalled();
    const rows = await db.execute(sql`select events from hyperliquid_egress_quota where egress_key = ${binding.egressKey}`);
    expect(rows.rows[0]!.events).toHaveLength(1);
  } finally { reader.close(); }
});

it('cancels a real SQL idle snapshot queued before a fresh fill and refunds all unused 284 weight without HTTP', async () => {
  const saved = { ...structuredClone(fixture().accountSource.snapshot), accountAddress: `0x${'77'.repeat(20)}` };
  const retained = await repository.claim(); await repository.save(retained!, saved);
  await db.update(copyFollowerObservationBudget).set({ nextAllowedAt: sql`clock_timestamp() - interval '1 second'` });
  await db.update(copyFollowerObservationJobs).set({ nextRunAt: sql`clock_timestamp() - interval '1 second'`, issue: 'unsupported_mode' }).where(eq(copyFollowerObservationJobs.accountId, 'residual'));
  const [prior] = await db.select().from(copyFollowerObservationJobs).where(eq(copyFollowerObservationJobs.accountId, 'residual'));
  const { reader, count } = await queuedReader();
  const work = new CopyFollowerSnapshotCollector(repository, reader, testConfig(), new BackgroundJobs()).runOnce();
  await waitQueued();
  const [before] = await db.select().from(copyFollowerObservationBudget);
  await foreground();
  await vi.advanceTimersByTimeAsync(72_000); await work;
  expect(count()).toBe(0);
  expect(budget!.introspect().tokensAvailable).toBeCloseTo(480, 1);
  expect(await db.select().from(copyFollowerObservations)).toHaveLength(1);
  const [job] = await db.select().from(copyFollowerObservationJobs).where(eq(copyFollowerObservationJobs.accountId, 'residual'));
  expect(job.issue).toBe('unsupported_mode'); expect(job.latestObservationId).toBe(prior.latestObservationId);
  const [after] = await db.select().from(copyFollowerObservationBudget);
  expect(after.nextAllowedAt).toEqual(before.nextAllowedAt); expect(after.nextSnapshotAllowedAt).toEqual(before.nextSnapshotAllowedAt);
});

it.each(['recovery', 'fairness'] as const)('retains original %s admission when foreground arrives during budget queue', async kind => {
  if (kind === 'recovery') await db.update(copyFundingOperations).set({ status: 'accepted' }).where(eq(copyFundingOperations.id, 'deposit'));
  else { await foreground(); await db.insert(copyFollowerObservationBudget).values({ network: 'testnet', nextAllowedAt: sql`clock_timestamp() - interval '1 second'`, nextSnapshotAllowedAt: sql`clock_timestamp() - interval '1 second'` }); }
  const { reader, count } = await queuedReader();
  const work = new CopyFollowerSnapshotCollector(repository, reader, testConfig(), new BackgroundJobs()).runOnce();
  await waitQueued(); if (kind === 'recovery') await foreground(); await vi.advanceTimersByTimeAsync(72_000); await work;
  expect(count()).toBeGreaterThan(0); // Real HTTP started: failure must keep its charge.
  expect(budget!.introspect().tokensAvailable).toBeLessThan(480);
});

it.each(['token', 'owner', 'revision', 'network', 'address'] as const)('does not send queued HTTP when original claim %s changes', async field => {
  const { reader, count } = await queuedReader();
  const work = new CopyFollowerSnapshotCollector(repository, reader, testConfig(), new BackgroundJobs()).runOnce();
  await waitQueued();
  if (field === 'token') await db.update(copyFollowerObservationJobs).set({ claimToken: 'superseded' }).where(eq(copyFollowerObservationJobs.accountId, 'residual'));
  else await db.update(copyExecutionAccounts).set(field === 'owner' ? { privyUserId: 'foreign-owner' } : field === 'revision' ? { revision: 2 } : field === 'network' ? { network: 'mainnet' } : { address: `0x${'88'.repeat(20)}` }).where(eq(copyExecutionAccounts.id, 'residual'));
  await vi.advanceTimersByTimeAsync(72_000); await work;
  expect(count()).toBe(0); expect(budget!.introspect().tokensAvailable).toBeCloseTo(480, 1);
});

it('rejects copied metadata that invents an original fairness admission', async () => {
  const claim = await repository.claim(); expect(claim).not.toBeNull();
  await foreground();
  await expect(repository.assertReadEligible({ ...claim!, admission: 'fairness' })).rejects.toThrow('live_account_snapshot_scheduling_deferred');
});
it('does not carry an ended recovery exemption into unrelated foreground work', async () => {
  await db.update(copyFundingOperations).set({ status: 'accepted' }).where(eq(copyFundingOperations.id, 'deposit'));
  const claim = await repository.claim(); expect(claim).not.toBeNull();
  await db.update(copyFundingOperations).set({ status: 'credited' }).where(eq(copyFundingOperations.id, 'deposit'));
  await foreground();
  await expect(repository.assertReadEligible(claim!)).rejects.toThrow('live_account_snapshot_scheduling_deferred');
});
it('leaves another-account mainnet reporting admission unchanged when testnet foreground arrives', async () => {
  await db.update(copyExecutionAccounts).set({ network: 'mainnet' }).where(eq(copyExecutionAccounts.id, 'residual'));
  await db.update(copyFundingOperations).set({ network: 'mainnet' }).where(eq(copyFundingOperations.id, 'deposit'));
  const original = testConfig().value;
  const config = { value: { ...original, hyperliquid: { ...original.hyperliquid, wallet: { ...original.hyperliquid.wallet, network: 'mainnet' } } } } as AppConfig;
  repository = new CopyFollowerSnapshotRepository(db, config);
  const { reader, count } = await queuedReader('mainnet');
  const work = new CopyFollowerSnapshotCollector(repository, reader, config, new BackgroundJobs()).runOnce();
  await waitQueued(); await foreground(); await vi.advanceTimersByTimeAsync(72_000); await work;
  expect(count()).toBeGreaterThan(0); expect(budget!.introspect().tokensAvailable).toBeLessThan(480);
});
it('refunds unused acquisition and sends no HTTP if the scheduling SQL check fails', async () => {
  const { reader, count } = await queuedReader();
  vi.spyOn(repository, 'assertReadEligible').mockRejectedValueOnce(new Error('SQL unavailable'));
  const work = new CopyFollowerSnapshotCollector(repository, reader, testConfig(), new BackgroundJobs()).runOnce();
  await waitQueued(); await vi.advanceTimersByTimeAsync(72_000); await work;
  expect(count()).toBe(0); expect(budget!.introspect().tokensAvailable).toBeCloseTo(480, 1);
  const [job] = await db.select().from(copyFollowerObservationJobs).where(eq(copyFollowerObservationJobs.accountId, 'residual'));
  expect(job.issue).toBe('source_unavailable');
});

it('keeps original issued purpose immutable and refuses its copied or missing metadata', async () => {
  const claim = await repository.claim(); expect(claim).not.toBeNull();
  expect(Reflect.set(claim!, 'admission', 'fairness')).toBe(false);
  await foreground();
  await expect(repository.assertReadEligible(claim!)).rejects.toThrow('live_account_snapshot_scheduling_deferred');
  await expect(repository.assertReadEligible({ ...claim! })).rejects.toThrow('live_account_snapshot_scheduling_deferred');
  const { admission: _admission, ...missing } = claim!;
  await expect(repository.assertReadEligible(missing as typeof claim & {})).rejects.toThrow('live_account_snapshot_scheduling_deferred');
});

it.each(['resolve', 'reject'] as const)('retains issue and refunds exactly once when near-deadline reserve is followed by late SQL %s', async outcome => {
  await db.update(copyFollowerObservationJobs).set({ issue: 'unsupported_mode' }).where(eq(copyFollowerObservationJobs.accountId, 'residual'));
  const { reader, count } = await queuedReader();
  const adjust = vi.spyOn(budget!, 'adjust');
  const ahead = budget!.acquire(220, 'background');
  let release!: () => void, entered!: () => void, finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const gateEntered = new Promise<void>(resolve => { entered = resolve; });
  const gateFinished = new Promise<void>(resolve => { finished = resolve; });
  const original = repository.assertReadEligible.bind(repository);
  vi.spyOn(repository, 'assertReadEligible').mockImplementationOnce(async claim => {
    entered(); await held;
    try {
      if (outcome === 'reject') throw new Error('late SQL failure');
      await original(claim);
    } finally { finished(); }
  });
  const work = new CopyFollowerSnapshotCollector(repository, reader, testConfig(), new BackgroundJobs()).runOnce();
  for (let i = 0; i < 200 && budget!.queued().background < 2; i++) await realDelay(5);
  expect(budget!.queued().background).toBe(2);
  await vi.advanceTimersByTimeAsync(120_700); await ahead; await gateEntered;
  await vi.advanceTimersByTimeAsync(3_000); await work;
  expect(count()).toBe(0);
  expect(adjust).toHaveBeenCalledExactlyOnceWith(-284);
  expect(budget!.introspect().tokensAvailable).toBeCloseTo(123_700 * 400 / 60_000 - 220, 1);
  const [job] = await db.select().from(copyFollowerObservationJobs).where(eq(copyFollowerObservationJobs.accountId, 'residual'));
  expect(job.issue).toBe('unsupported_mode');
  // The SELECT can finish later; it never owns another refund or provider continuation.
  await vi.advanceTimersByTimeAsync(7_000); release(); await gateFinished; await realDelay(5);
  expect(count()).toBe(0); expect(adjust).toHaveBeenCalledTimes(1);
});

it('rejects an illegal original address before taking any local credit', async () => {
  const { reader, count } = await queuedReader(); const adjust = vi.spyOn(budget!, 'adjust');
  await expect(reader.observe('not-an-address', async () => {})).rejects.toThrow();
  expect(budget!.queued().background).toBe(0); expect(budget!.introspect().tokensAvailable).toBe(0);
  expect(adjust).not.toHaveBeenCalled(); expect(count()).toBe(0);
});
it('closes a still-queued reader without charging or replacing its prior issue', async () => {
  await db.update(copyFollowerObservationJobs).set({ issue: 'unsupported_mode' }).where(eq(copyFollowerObservationJobs.accountId, 'residual'));
  const { reader, count } = await queuedReader(); const adjust = vi.spyOn(budget!, 'adjust');
  const work = new CopyFollowerSnapshotCollector(repository, reader, testConfig(), new BackgroundJobs()).runOnce();
  await waitQueued(); reader.close(); await work;
  expect(budget!.queued().background).toBe(0); expect(adjust).not.toHaveBeenCalled(); expect(count()).toBe(0);
  const [job] = await db.select().from(copyFollowerObservationJobs).where(eq(copyFollowerObservationJobs.accountId, 'residual'));
  expect(job.issue).toBe('unsupported_mode');
});
it('closes an acquired read during the SQL gate and refunds once without late HTTP', async () => {
  await db.update(copyFollowerObservationJobs).set({ issue: 'unsupported_mode' }).where(eq(copyFollowerObservationJobs.accountId, 'residual'));
  const { reader, count } = await queuedReader(); const adjust = vi.spyOn(budget!, 'adjust');
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const gateEntered = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(repository, 'assertReadEligible').mockImplementationOnce(async () => { entered(); await held; });
  const work = new CopyFollowerSnapshotCollector(repository, reader, testConfig(), new BackgroundJobs()).runOnce();
  await waitQueued(); await vi.advanceTimersByTimeAsync(72_000); await gateEntered;
  reader.close(); await work;
  expect(adjust).toHaveBeenCalledExactlyOnceWith(-284); expect(count()).toBe(0);
  release(); await realDelay(5); await vi.advanceTimersByTimeAsync(10_000);
  expect(adjust).toHaveBeenCalledTimes(1); expect(count()).toBe(0);
  const [job] = await db.select().from(copyFollowerObservationJobs).where(eq(copyFollowerObservationJobs.accountId, 'residual'));
  expect(job.issue).toBe('unsupported_mode');
});
