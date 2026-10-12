import { testConfig } from './config-test-utils.js';
import * as schema from '@trading-dashboard/shared/database';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { CopyLiveFlatCarry } from '../src/copy/live-worker/copy-live-flat-carry.js';
import { CopyLiveManualCloser } from '../src/copy/live-worker/copy-live-stopper.js';
import { CopyLiveStopWorkerRepository } from '../src/copy/live-worker/copy-live-stop-worker.repository.js';
import type { ReduceOnlyCloser } from '../src/copy/live-worker/reduce-only-closer.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

// 2c-B: a single-position close that left the follower flat in a coin resets
// that coin's reduction carry, but never while a leg of it is in flight.
let db: TestDb, pool: Pool, seed: Awaited<ReturnType<typeof preparationFixture>>;
const leader = `0x${'44'.repeat(20)}`, stream = `mainnet:${leader}`, carriedAt = new Date(now - 1000);
beforeAll(() => { pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
beforeEach(async () => {
  db = getTestDb(); seed = await preparationFixture(db);
  await db.insert(schema.copyLiveSourceStreams).values({ id: stream, network: 'mainnet', leaderAddress: leader }).onConflictDoNothing();
  await db.insert(schema.copyLiveReductionCarry).values({ mandateId: 'mandate', coin: 'BTC', carry: '0.09', revision: 3, updatedAt: carriedAt });
  await db.insert(schema.copyLiveManualCloses).values({ id: 'close', userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: 'owner-close-0001', coin: 'BTC',
    createdAt: new Date(now - 500), updatedAt: new Date(now - 500) });
});
afterAll(async () => { await pool.end(); await closeTestDb(); });

function closer(observe: () => Promise<unknown> = async () => ({ positions: [] })) {
  return { network: 'testnet', close: vi.fn(async () => null), observe: vi.fn(observe) } as unknown as ReduceOnlyCloser;
}
const manual = (double: ReduceOnlyCloser) => new CopyLiveManualCloser(new CopyLiveStopWorkerRepository(db, new UnitOfWork(db), testConfig()), double,
  { runFor: async () => undefined }, new CopyLiveFlatCarry('testnet', pool, () => now), undefined, () => now);
const carry = async () => (await db.select().from(schema.copyLiveReductionCarry).where(eq(schema.copyLiveReductionCarry.coin, 'BTC')))[0]!;
const closeRow = async () => (await db.select().from(schema.copyLiveManualCloses))[0]!;

/** A copy leg of this generation in `coin`, journaled in `state`. */
async function leg(tid: number, state: string, coin = 'BTC', mandateId = 'mandate') {
  const fillId = `${stream}:${tid}`, key = `testnet:${seed.f.identity.accountAddress}:leg-${tid}`;
  await db.insert(schema.copyLiveSourceFills).values({ id: fillId, streamId: stream, network: 'mainnet', leaderAddress: leader, tid: String(tid), providerTime: new Date(now - 3000),
    receivedAt: new Date(now - 3000), coin, oid: String(1000 + tid), tradeKey: `oid:${1000 + tid}`, px: '100', sz: '1', side: 'A', startPosition: '1', normalized: {}, raw: {}, sourceDigest: 'a'.repeat(64) });
  await db.insert(schema.copyLiveExecutions).values({ key, network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: `0x${'33'.repeat(20)}`,
    cloid: `0x${tid.toString(16).padStart(32, '0')}`, nonce: now + tid, userId: 1, strategyId: 9, state, updatedAt: new Date(now - 2000), record: { key, state } });
  await db.insert(schema.copyLiveSignalLegs).values({ id: `leg-${tid}`, mandateId, sourceFillId: fillId, leg: 'close', tradeKey: `oid:${1000 + tid}`, sign: 1, size: '1', fraction: '0.5',
    executionKey: key, state: 'prepared', createdAt: new Date(now - 2000), updatedAt: new Date(now - 2000) });
  await db.insert(schema.copyLiveIntentProvenance).values({ key, legId: `leg-${tid}`, mandateId, mandateRevision: 2, sourceDigest: 'a'.repeat(64), settingsDigest: 'b'.repeat(64),
    fingerprint: 'c'.repeat(64), plannerVersion: 1, intent: {}, sizingBasis: {}, admittedAt: new Date(now - 2000) });
  return key;
}
async function reservation(key: string, tid: number, state: 'held' | 'unknown') {
  await db.insert(schema.copyLiveRiskReservations).values({ key, accountId: 'account', userId: 1, strategyId: 9, network: 'testnet', accountAddress: seed.f.identity.accountAddress,
    cloid: `0x${tid.toString(16).padStart(32, '0')}`, fingerprint: 'c'.repeat(64), walletId: 'agent', authorizationId: 'grant', strategyVersion: 2, policyVersion: 1, authorizationVersion: 4,
    coin: 'BTC', dex: '', asset: 0, notionalUsd: '10', marginUsd: '1', feeBufferUsd: '0.01', payload: { intent: {}, action: {} }, sourceDigest: 'a'.repeat(64), state,
    ...(state === 'unknown' ? { attemptedAt: new Date(now - 1900) } : {}), expiresAt: new Date(now + 60000), createdAt: new Date(now - 2000), updatedAt: new Date(now - 2000) });
}

describe('the reduction carry of a coin a single-position close left flat (2c-B)', () => {
  it('is reset to 0 (revision + 1, never an earlier time) and the close ends done', async () => {
    await manual(closer()).tick();
    expect(await closeRow()).toMatchObject({ state: 'done', reason: null });
    const row = await carry();
    expect(row).toMatchObject({ carry: '0', revision: 4 });
    expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(carriedAt.getTime());
  });

  it.each(['prepared', 'submitting', 'unknown', 'resting'])('waits while a leg of the coin is %s: the close stays requested, then resets once it ended', async state => {
    const key = await leg(7, state);
    await manual(closer()).tick();
    expect(await closeRow()).toMatchObject({ state: 'requested' });
    expect(await carry()).toMatchObject({ carry: '0.09', revision: 3, updatedAt: carriedAt });
    await db.update(schema.copyLiveExecutions).set({ state: 'cancelled' }).where(eq(schema.copyLiveExecutions.key, key));
    await manual(closer()).tick();
    expect(await closeRow()).toMatchObject({ state: 'done' });
    expect(await carry()).toMatchObject({ carry: '0', revision: 4 });
  });

  it.each(['held', 'unknown'] as const)('waits while a reservation of the coin is %s (its order not settled yet)', async state => {
    const key = await leg(8, 'filled'); await reservation(key, 8, state);
    await manual(closer()).tick();
    expect(await closeRow()).toMatchObject({ state: 'requested' });
    expect(await carry()).toMatchObject({ carry: '0.09', revision: 3 });
    await db.update(schema.copyLiveRiskReservations).set({ state: 'released', releaseReason: 'verified_settlement', releaseEvidenceDigest: 'd'.repeat(64), attemptedAt: new Date(now - 1900) });
    await manual(closer()).tick();
    expect(await carry()).toMatchObject({ carry: '0', revision: 4 });
  });

  it('is not held by a leg of another coin', async () => {
    await leg(9, 'unknown', 'ETH');
    await manual(closer()).tick();
    expect(await closeRow()).toMatchObject({ state: 'done' });
    expect(await carry()).toMatchObject({ carry: '0', revision: 4 });
  });

  it('waits when a close settled between the reading of the carry and the flat observation', async () => {
    const double = closer(async () => {
      await db.update(schema.copyLiveReductionCarry).set({ carry: '0.05', revision: 4, updatedAt: new Date(now - 100) });
      return { positions: [] };
    });
    await manual(double).tick();
    expect(await closeRow()).toMatchObject({ state: 'requested' });
    expect(await carry()).toMatchObject({ carry: '0.05', revision: 4 });
    await manual(closer()).tick();
    expect(await carry()).toMatchObject({ carry: '0', revision: 5 });
  });

  it('waits while an order or settlement of the account holds its risk locks', async () => {
    await new PostgresLiveRiskScope(pool, () => now).run({ userId: 1, network: 'testnet', accountAddress: seed.f.identity.accountAddress }, async () => {
      await manual(closer()).tick();
    });
    expect(await closeRow()).toMatchObject({ state: 'requested' });
    expect(await carry()).toMatchObject({ carry: '0.09', revision: 3 });
    await manual(closer()).tick();
    expect(await carry()).toMatchObject({ carry: '0', revision: 4 });
  });
});
