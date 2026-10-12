import { testConfig } from './config-test-utils.js';
import * as schema from '@trading-dashboard/shared/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { CopyLiveManualCloser } from '../src/copy/live-worker/copy-live-stopper.js';
import { CopyLiveStopWorkerRepository } from '../src/copy/live-worker/copy-live-stop-worker.repository.js';
import { CopyLiveWorkerRepository } from '../src/copy/live-worker/copy-live-worker.repository.js';
import type { ReduceOnlyCloser } from '../src/copy/live-worker/reduce-only-closer.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

// O4: the leader goes flat, a close of what the follower still holds is
// requested, and the leader opens the coin again before that close ran.
let db: TestDb, seed: Awaited<ReturnType<typeof preparationFixture>>;
const leader = `0x${'44'.repeat(20)}`, stream = `mainnet:${leader}`;
beforeEach(async () => {
  db = getTestDb(); seed = await preparationFixture(db);
  await db.insert(schema.copyLiveSourceStreams).values({ id: stream, network: 'mainnet', leaderAddress: leader }).onConflictDoNothing();
});
afterAll(async () => { await closeTestDb(); });

async function leg(tid: number, time: number, leg: 'open' | 'close', state: 'pending' | 'submitted' | 'settled', extra: Partial<typeof schema.copyLiveDispatches.$inferInsert> = {},
  side: 'B' | 'A' = leg === 'open' ? 'B' : 'A') {
  const fillId = `${stream}:${tid}`;
  await db.insert(schema.copyLiveSourceFills).values({ id: fillId, streamId: stream, network: 'mainnet', leaderAddress: leader, tid: String(tid), providerTime: new Date(time),
    receivedAt: new Date(time), coin: 'BTC', oid: String(1000 + tid), tradeKey: `oid:${1000 + tid}`, px: '100', sz: '1', side, startPosition: '0',
    normalized: {}, raw: {}, sourceDigest: 'a'.repeat(64) });
  const id = `mandate|${fillId}|${leg}`, key = `exec-${tid}`;
  if (state !== 'pending') await db.insert(schema.copyLiveExecutions).values({ key, network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: `0x${'33'.repeat(20)}`,
    cloid: `0x${tid.toString(16).padStart(32, '0')}`, nonce: now + tid, userId: 1, strategyId: 9, state: 'filled', updatedAt: new Date(now), record: { key, state: 'filled' } });
  await db.insert(schema.copyLiveDispatches).values({ id, mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', sourceFillId: fillId, leg, coin: 'BTC', state,
    ...(state !== 'pending' ? { executionKey: key } : {}), leaderTime: new Date(time), receivedAt: new Date(time), ...extra });
  return id;
}
const flatClose = (closeLegId: string, at: number) => db.insert(schema.copyLiveManualCloses).values({ id: 'flat-close', userId: 1, accountId: 'account', strategyId: 9,
  idempotencyKey: `reconcile:${closeLegId}`, coin: 'BTC', createdAt: new Date(at), updatedAt: new Date(at) });
function closer() {
  const close = vi.fn(async () => null);
  const double = { network: 'testnet', close, observe: vi.fn(async () => ({ positions: [{ coin: 'BTC', size: '0.5' }] })) } as unknown as ReduceOnlyCloser;
  return { double, close };
}
const manual = (double: ReduceOnlyCloser) => new CopyLiveManualCloser(new CopyLiveStopWorkerRepository(db, new UnitOfWork(db), testConfig()), double, { runFor: async () => undefined },
  undefined, () => now);

describe('a close after the leader went flat, when the leader opens the coin again (O4)', () => {
  it('still closes what the follower holds while the leader stays flat', async () => {
    const closeLeg = await leg(1, now - 5000, 'close', 'settled'); await flatClose(closeLeg, now - 4000);
    const { double, close } = closer();
    await manual(double).tick();
    expect(close).toHaveBeenCalledTimes(1);
    expect((await db.select().from(schema.copyLiveManualCloses))[0]).toMatchObject({ state: 'requested' });
  });

  it('is cancelled, sending nothing, once the leader opened the coin again: the fresh mirror open is not closed', async () => {
    const closeLeg = await leg(1, now - 5000, 'close', 'settled'); await flatClose(closeLeg, now - 4000);
    await leg(2, now - 3000, 'open', 'settled', { settledAt: new Date(now - 2000) });
    const { double, close } = closer();
    await manual(double).tick();
    expect(close).not.toHaveBeenCalled();
    expect((await db.select().from(schema.copyLiveManualCloses))[0]).toMatchObject({ state: 'refused', reason: 'leader_reopened' });
  });

  it('an open of the same millisecond orders by tid: an earlier one is not a re-open', async () => {
    await leg(1, now - 5000, 'open', 'settled');
    const closeLeg = await leg(2, now - 5000, 'close', 'settled'); await flatClose(closeLeg, now - 4000);
    const { double, close } = closer();
    await manual(double).tick();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('an order already sent stops at the gate once the copy journaled a re-open, not while that open only waits', async () => {
    const closeLeg = await leg(1, now - 5000, 'close', 'settled'); await flatClose(closeLeg, now - 4000);
    let stillWanted: (() => Promise<boolean>) | undefined;
    const { double, close } = closer();
    close.mockImplementation((async (request: { stillWanted: () => Promise<boolean> }) => { stillWanted = request.stillWanted; return null; }) as never);
    await manual(double).tick();
    expect(await stillWanted!()).toBe(true);
    const reopen = await leg(2, now - 3000, 'open', 'pending');
    expect(await stillWanted!()).toBe(true);
    await db.insert(schema.copyLiveExecutions).values({ key: 'exec-2', network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: `0x${'33'.repeat(20)}`,
      cloid: `0x${'2'.padStart(32, '0')}`, nonce: now + 2, userId: 1, strategyId: 9, state: 'unknown', updatedAt: new Date(now), record: { key: 'exec-2', state: 'unknown' } });
    await db.update(schema.copyLiveDispatches).set({ state: 'submitted', executionKey: 'exec-2' }).where(eq(schema.copyLiveDispatches.id, reopen));
    expect(await stillWanted!()).toBe(false);
  });

  // 2c-A: only an open the copy journaled or sent can be in what the follower
  // holds. One still waiting (either side) waits for the close, which runs.
  it.each([['same side', 'B'], ['opposite side', 'A']] as const)('a %s re-open not journaled yet: the close runs, then the open may go', async (_side, side) => {
    const repo = new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig());
    const closeLeg = await leg(1, now - 5000, 'close', 'settled'); await flatClose(closeLeg, now - 4000);
    await leg(2, now - 3000, 'open', 'pending', {}, side);
    const { double, close } = closer();
    await manual(double).tick();
    expect(close).toHaveBeenCalledTimes(1);
    expect((await db.select().from(schema.copyLiveManualCloses))[0]).toMatchObject({ state: 'requested' });
    expect(await repo.closeRequested('account', 'BTC')).toBe(true); // the open waits
    // The close's attempt ended and the follower is flat: done, and the open may go.
    await db.insert(schema.copyLiveExecutions).values({ key: (await db.select().from(schema.copyLiveManualCloses))[0]!.executionKeys[0]!, network: 'testnet', accountAddress: seed.f.identity.accountAddress,
      signerAddress: `0x${'33'.repeat(20)}`, cloid: `0x${'c'.repeat(32)}`, nonce: now + 9, userId: 1, strategyId: 9, state: 'filled', updatedAt: new Date(now), record: { state: 'filled' } });
    (double.observe as ReturnType<typeof vi.fn>).mockResolvedValue({ positions: [] });
    await manual(double).tick();
    expect(close).toHaveBeenCalledTimes(1);
    expect((await db.select().from(schema.copyLiveManualCloses))[0]).toMatchObject({ state: 'done', reason: null });
    expect(await repo.closeRequested('account', 'BTC')).toBe(false);
  });

  it.each(['submitted', 'journaled'] as const)('a re-open already %s: the close is refused leader_reopened, sending nothing', async how => {
    const closeLeg = await leg(1, now - 5000, 'close', 'settled'); await flatClose(closeLeg, now - 4000);
    if (how === 'submitted') await leg(2, now - 3000, 'open', 'submitted', {}, 'A');
    else {
      // Journaled by the preparation, the dispatch row not updated yet (a crash between).
      await leg(2, now - 3000, 'open', 'pending', {}, 'A');
      await db.insert(schema.copyLiveExecutions).values({ key: 'exec-2', network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: `0x${'33'.repeat(20)}`,
        cloid: `0x${'2'.padStart(32, '0')}`, nonce: now + 2, userId: 1, strategyId: 9, state: 'prepared', updatedAt: new Date(now), record: { key: 'exec-2', state: 'prepared' } });
      await db.insert(schema.copyLiveSignalLegs).values({ id: 'leg-2', mandateId: 'mandate', sourceFillId: `${stream}:2`, leg: 'open', tradeKey: 'oid:1002', sign: -1, size: '1',
        executionKey: 'exec-2', state: 'prepared', createdAt: new Date(now), updatedAt: new Date(now) });
    }
    const { double, close } = closer();
    await manual(double).tick();
    expect(close).not.toHaveBeenCalled();
    expect((await db.select().from(schema.copyLiveManualCloses))[0]).toMatchObject({ state: 'refused', reason: 'leader_reopened' });
  });

  it('a new open of the coin waits while that close is requested', async () => {
    const repo = new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig());
    expect(await repo.closeRequested('account', 'BTC')).toBe(false);
    const closeLeg = await leg(1, now - 5000, 'close', 'settled'); await flatClose(closeLeg, now - 4000);
    expect(await repo.closeRequested('account', 'BTC')).toBe(true);
    expect(await repo.closeRequested('account', 'ETH')).toBe(false);
  });

  it('a close requested before the re-open settled never makes the leader\'s later close position_closed_by_owner', async () => {
    const repo = new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig());
    const closeLeg = await leg(1, now - 5000, 'close', 'settled'); await flatClose(closeLeg, now - 4000);
    // The re-open is enqueued (DB clock) and settles after the close was requested...
    await leg(2, now - 3000, 'open', 'settled', { createdAt: new Date(now - 3500), settledAt: new Date(now - 2000) });
    // ...and the close then ends done (its order closed only the old leftover).
    await db.update(schema.copyLiveManualCloses).set({ state: 'done', executionKeys: ['testnet:k:1'], updatedAt: new Date(now - 1000) });
    expect(await repo.closedByOwner('mandate', 'account', 'BTC')).toBe(false);
  });

  it('a close that ended done without an order never counts as the owner closing the position', async () => {
    const repo = new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig());
    await leg(2, now - 3000, 'open', 'settled', { createdAt: new Date(now - 3000), settledAt: new Date(now - 2500) });
    await db.insert(schema.copyLiveManualCloses).values({ id: 'owner', userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: 'owner-close', coin: 'BTC',
      state: 'done', executionKeys: [], createdAt: new Date(now - 2000), updatedAt: new Date(now - 1000) });
    expect(await repo.closedByOwner('mandate', 'account', 'BTC')).toBe(false);
    await db.update(schema.copyLiveManualCloses).set({ executionKeys: ['testnet:k:1'] });
    expect(await repo.closedByOwner('mandate', 'account', 'BTC')).toBe(true);
  });
});
