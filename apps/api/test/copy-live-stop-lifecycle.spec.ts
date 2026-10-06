import { testConfig } from './config-test-utils.js';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { copyLiveStopOperations, copyLiveMandates, copyStrategies, copyLiveExecutions, copyLiveIntentProvenance, copyLiveRiskReservations, copyExecutionAccounts, users, paperAccounts } from '@trading-dashboard/shared/database';
import { liveCopyStopSchema } from '@trading-dashboard/shared/contracts';
import { CopyLiveStopRepository } from '../src/copy/copy-live-stop.repository.js';
import { CopyLiveStopService } from '../src/copy/copy-live-stop.service.js';
import { CopyLiveMandateRepository } from '../src/copy/copy-live-mandate.repository.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { PostgresLivePreparation } from '../src/copy/live/postgres-live-preparation.js';
import { HyperliquidLiveAccountObserver } from '../src/copy/live/live-account-observer.js';
import { HyperliquidLiveMarketResolver } from '../src/copy/live/live-market-resolver.js';
import { HyperliquidLiveRiskProvider } from '../src/copy/live/live-risk-provider.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { closeTestDb, getTestDb, insertUser, type TestDb } from './db-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';

let db: TestDb, pool: Pool, service: CopyLiveStopService, seed: Awaited<ReturnType<typeof preparationFixture>>, clock: number;
const body = () => ({ idempotencyKey: 'durable-stop-request-0001', expectedMandateRevision: 2 });
beforeAll(() => { db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 }); });
beforeEach(async () => {
  seed = await preparationFixture(db); clock = now;
  service = new CopyLiveStopService(new CopyLiveStopRepository(db, new CopyLiveMandateRepository(db, testConfig())), new UnitOfWork(db), () => clock);
});
afterAll(async () => { await pool.end(); await closeTestDb(); });
async function prepareActualJournal() {
  const acquire = async () => {}, fetcher: typeof fetch = async () => { throw Error('No remote requests in fixtures'); };
  const observer = new HyperliquidLiveAccountObserver('testnet', acquire, fetcher, () => clock);
  const resolver = new HyperliquidLiveMarketResolver('testnet', acquire, fetcher, () => clock);
  const provider = new HyperliquidLiveRiskProvider('testnet', acquire, fetcher, () => clock);
  vi.spyOn(observer, 'observe').mockResolvedValue(seed.f.accountSource.snapshot);
  vi.spyOn(resolver, 'resolve').mockResolvedValue(seed.f.market);
  vi.spyOn(provider, 'observe').mockResolvedValue({ network: 'testnet', accountAddress: seed.f.identity.accountAddress, coin: 'BTC', dex: '', asset: 0,
    market: seed.f.market, earliestObservedAt: now, completedAt: now, sourceDigest: 'a'.repeat(64), quote: seed.f.quote,
    leverageProofs: seed.f.leverageProofs, fees: seed.f.fees } as never);
  const preparation = new PostgresLivePreparation(observer, resolver, provider,
    { slippageBps: '50', extraRiskBufferBps: '0', restingOrderBuilderFeeCapTenthsBps: 100 }, () => clock);
  return new PostgresLiveRiskScope(pool, () => clock).run({ userId: 1, network: 'testnet', accountAddress: seed.consent.accountAddress,
    source: { network: 'testnet', leaderAddress: seed.consent.leaderAddress } }, (_scope, session) =>
    preparation.prepare(session, { accountId: 'account', mandateId: 'mandate', sourceFillId: seed.fill.id, leg: 'open' }));
}
async function retainUnknownReservation(prepared: Awaited<ReturnType<typeof prepareActualJournal>>) {
  const { record, intent } = prepared;
  await db.update(copyLiveExecutions).set({ state: 'unknown', record: { ...record, state: 'unknown', updatedAt: clock } }).where(eq(copyLiveExecutions.key, record.key));
  await db.insert(copyLiveRiskReservations).values({ key: record.key, accountId: 'account', userId: 1, strategyId: 9,
    network: 'testnet', accountAddress: seed.consent.accountAddress, cloid: intent.cloid, fingerprint: record.fingerprint,
    walletId: intent.walletId, authorizationId: intent.authorizationId, strategyVersion: 2, policyVersion: 3, authorizationVersion: 4,
    coin: 'BTC', dex: '', asset: intent.asset, notionalUsd: '9', marginUsd: '9', feeBufferUsd: '1',
    payload: { intent, action: record.action }, sourceDigest: 'a'.repeat(64), state: 'unknown', attemptedAt: new Date(clock),
    expiresAt: new Date(clock + 60000), createdAt: new Date(clock), updatedAt: new Date(clock) });
}
it('tracks a genuine prepared journal without loading its unused sizing envelope', async () => {
  const prepared = await prepareActualJournal();
  await db.update(copyLiveIntentProvenance).set({ sizingBasis: { unused: 'x'.repeat(2 * 1024 * 1024) } });
  expect(await service.request(1, 'mandate', body())).toMatchObject({ state: 'requested', trackingComplete: true, trackedExecutionCount: 1 });
  expect((await db.select().from(copyLiveExecutions))[0].record).toEqual(prepared.record);
});
it('retains unknown liability from a revoked older generation without changing consent or releasing reservations', async () => {
  const prepared = await prepareActualJournal(); await retainUnknownReservation(prepared);
  await db.update(copyLiveMandates).set({ state: 'revoked', revision: 3 }); clock += 60001;
  const before = await db.select().from(copyLiveRiskReservations);
  expect(await service.request(1, 'mandate', { ...body(), expectedMandateRevision: 3 })).toMatchObject({ state: 'requested', trackingComplete: true, trackedExecutionCount: 1 });
  expect(await db.select().from(copyLiveRiskReservations)).toEqual(before);
  expect((await db.select().from(copyLiveMandates))[0]).toMatchObject({ state: 'revoked', revision: 3, intent: seed.consent });
});
it('blocks tracking for an account reservation whose journal belongs to a different owner', async () => {
  const prepared = await prepareActualJournal(); await retainUnknownReservation(prepared);
  const other = await insertUser(db); await db.update(copyLiveExecutions).set({ userId: other.id });
  expect(await service.request(1, 'mandate', body())).toMatchObject({ state: 'blocked', trackingComplete: false });
  expect((await db.select().from(copyLiveRiskReservations))[0].state).toBe('unknown');
});
it.each(['fingerprint', 'settingsDigest', 'mandateRevision', 'admittedAt'] as const)('blocks inconsistent original provenance %s', async field => {
  await prepareActualJournal();
  await db.update(copyLiveIntentProvenance).set(field === 'admittedAt' ? { admittedAt: new Date(clock + 1) } :
    field === 'mandateRevision' ? { mandateRevision: 3 } : { [field]: 'd'.repeat(64) });
  expect(await service.request(1, 'mandate', body())).toMatchObject({ state: 'blocked', trackingComplete: false, issue: 'tracked_execution_unproven' });
});
it('rejects provenance that claims a pre-activation mandate revision', async () => {
  await prepareActualJournal(); await db.update(copyLiveIntentProvenance).set({ mandateRevision: 1 });
  expect(await service.request(1, 'mandate', body())).toMatchObject({ state: 'blocked', trackingComplete: false });
});
it('atomically records the owner request and blocks new risk without claiming cancellations, flatness or refund', async () => {
  const result = liveCopyStopSchema.parse(await service.request(1, 'mandate', body()));
  expect(result).toMatchObject({ state: 'requested', desiredAction: 'cancel_and_close', originalMandateRevision: 2, trackedExecutionCount: 0, trackingComplete: true, flatVerifiedAt: null });
  expect((await db.select().from(copyStrategies))[0]).toMatchObject({ status: 'stopping', pauseNewRisk: true, reduceOnly: true, stoppedAt: null, cash: '0', withdrawn: '0' });
  expect((await db.select().from(copyLiveMandates))[0]).toMatchObject({ state: 'stopping', revision: 3, intent: seed.consent, consentDigest: 'b'.repeat(64) });
  expect(await db.select().from(paperAccounts)).toEqual([]);
  expect(await db.select().from(copyLiveExecutions)).toEqual([]);
});
it('recovers the exact original key across retries and a restarted service after its response is lost', async () => {
  const original = await service.request(1, 'mandate', body()); clock += 1000;
  const restarted = new CopyLiveStopService(new CopyLiveStopRepository(db, new CopyLiveMandateRepository(db, testConfig())), new UnitOfWork(db), () => clock);
  expect(await restarted.request(1, 'mandate', body())).toEqual(original);
  expect(await restarted.byKey(1, body().idempotencyKey)).toEqual(original);
  expect(await restarted.overview(1)).toEqual({ items: [original], truncated: false });
  expect(await db.select().from(copyLiveStopOperations)).toHaveLength(1);
  await expect(service.request(1, 'mandate', { ...body(), idempotencyKey: 'durable-stop-request-0002', expectedMandateRevision: 3 })).rejects.toMatchObject({ status: 409 });
});
it('serializes concurrent requests to one operation and one admission revision', async () => {
  const results = await Promise.all([service.request(1, 'mandate', body()), service.request(1, 'mandate', body())]);
  expect(results[0]).toEqual(results[1]);
  expect((await db.select().from(copyLiveMandates))[0].revision).toBe(3);
  expect(await db.select().from(copyLiveStopOperations)).toHaveLength(1);
});
it.each([{ expectedMandateRevision: 1 }, { idempotencyKey: 'short' }, { expectedMandateRevision: 0 }, { execute: true }, { destination: `0x${'77'.repeat(20)}` }])('refuses stale or forged stop input %j', async change => {
  await expect(service.request(1, 'mandate', { ...body(), ...change })).rejects.toMatchObject({ status: 'expectedMandateRevision' in change && change.expectedMandateRevision === 1 ? 409 : 400 });
  expect(await db.select().from(copyLiveStopOperations)).toHaveLength(0);
  expect((await db.select().from(copyStrategies))[0].status).toBe('active');
});
it('rejects foreign and disabled owners on request and recovery without exposing operation metadata', async () => {
  const other = (await insertUser(db)).id;
  await expect(service.request(other, 'mandate', body())).rejects.toMatchObject({ status: 404 });
  await service.request(1, 'mandate', body());
  await expect(service.byKey(other, body().idempotencyKey)).rejects.toMatchObject({ status: 404 });
  expect(await service.overview(other)).toEqual({ items: [], truncated: false });
  await db.update(users).set({ disabledAt: new Date(clock) }).where(eq(users.id, 1));
  for (const read of [() => service.request(1, 'mandate', body()), () => service.byKey(1, body().idempotencyKey), () => service.overview(1)])
    await expect(read()).rejects.toMatchObject({ status: 404 });
});
it.each(['ownerAddress', 'ownerDid', 'master', 'accountAddress'] as const)('rejects %s replacement rather than attaching an old stop to a new identity', async change => {
  if (change === 'ownerAddress') await db.update(users).set({ embeddedWalletAddress: `0x${'77'.repeat(20)}` });
  if (change === 'ownerDid') await db.update(users).set({ privyUserId: 'did:privy:replacement' });
  if (change === 'master') await db.update(copyExecutionAccounts).set({ privyWalletId: 'replacement-master' });
  if (change === 'accountAddress') await db.update(copyExecutionAccounts).set({ address: `0x${'77'.repeat(20)}` });
  await expect(service.request(1, 'mandate', body())).rejects.toMatchObject({ status: 409 });
  expect(await db.select().from(copyLiveStopOperations)).toHaveLength(0);
});
it('preserves unknown exchange liability and records blocked tracking when its original provenance is absent', async () => {
  const cloid = `0x${'88'.repeat(16)}`;
  await db.insert(copyLiveExecutions).values({ key: `testnet:${seed.consent.accountAddress}:${cloid}`, userId: 1, strategyId: 9, network: 'testnet', accountAddress: seed.consent.accountAddress,
    signerAddress: seed.consent.agentAddress, cloid, nonce: clock, state: 'unknown', record: { unproven: true }, updatedAt: new Date(clock) });
  const before = await db.select().from(copyLiveExecutions);
  expect(await service.request(1, 'mandate', body())).toMatchObject({ state: 'blocked', trackingComplete: false, issue: 'tracked_execution_unproven', flatVerifiedAt: null });
  expect(await db.select().from(copyLiveExecutions)).toEqual(before);
  expect((await db.select().from(copyStrategies))[0]).toMatchObject({ status: 'stopping', pauseNewRisk: true, stoppedAt: null });
});
it('waits for the original execution user fence and rechecks the observed revision afterwards', async () => {
  const scope = new PostgresLiveRiskScope(pool, () => clock);
  let work!: Promise<unknown>;
  await scope.run({ userId: 1, network: 'testnet', accountAddress: seed.consent.accountAddress }, async () => {
    work = service.request(1, 'mandate', body()); void work.catch(() => undefined);
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = (await pool.query("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objsubid=2 AND classid=7404 AND objid=1) AS waiting")).rows[0].waiting;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(waiting).toBe(true);
    await db.update(copyLiveMandates).set({ revision: 3 });
  });
  await expect(work).rejects.toMatchObject({ status: 409 });
  expect(await db.select().from(copyLiveStopOperations)).toHaveLength(0);
});
it('database constraints refuse stopped without an actual flat certificate', async () => {
  const stop = await service.request(1, 'mandate', body());
  await expect(db.update(copyLiveStopOperations).set({ state: 'stopped' }).where(eq(copyLiveStopOperations.id, stop.id))).rejects.toThrow();
  expect((await service.byKey(1, body().idempotencyKey)).state).toBe('requested');
});
