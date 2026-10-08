import { testConfig } from './config-test-utils.js';
import * as schema from '@trading-dashboard/shared/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { digest as mandateDigest } from '../src/copy/copy-live-mandate-evidence.js';
import { CopyLiveSourceRepository } from '../src/copy/copy-live-source.repository.js';
import { liveSourceExecutionCloid } from '../src/copy/live/postgres-live-preparation.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import type { LiveExecutionRecord } from '../src/copy/live/live-execution.js';
import type { LiveExecutionHooks, LiveExecutionRequest } from '../src/copy/live/live-execution-runtime.js';
import { CLOSE_ATTEMPT_LIMIT, CopyLiveEngine, type LiveEngineDependencies } from '../src/copy/live-worker/copy-live-engine.js';
import { CopyLiveWorkerRepository } from '../src/copy/live-worker/copy-live-worker.repository.js';
import { WatchedMainnetSource } from '../src/copy/live-worker/watched-mainnet-source.js';
import type { LiveSettleOutcome, LiveSettleRequest } from '../src/copy/live-worker/copy-live-settler.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

// Real SQL, real watched-source reads and source repository; the runtime
// (signing/exchange) and the settler are doubles that record their calls.
let db: TestDb, clock: number, seed: Awaited<ReturnType<typeof preparationFixture>>;
const leader = `0x${'44'.repeat(20)}`;
type Runtime = (request: LiveExecutionRequest, hooks: Pick<LiveExecutionHooks, 'onExchange'>) => Promise<LiveExecutionRecord>;
let runtimeImpl: Runtime, settleImpl: (request: LiveSettleRequest) => Promise<LiveSettleOutcome>;
const runtimeCalls: LiveExecutionRequest[] = [], settleCalls: LiveSettleRequest[] = [];
const keyOf = (fillId: string, leg: 'open' | 'close') => `testnet:${seed.f.identity.accountAddress}:${liveSourceExecutionCloid('mandate', fillId, leg)}`;

async function journal(key: string, state: string) {
  await db.insert(schema.copyLiveExecutions).values({ key, network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: `0x${'33'.repeat(20)}`,
    cloid: key.split(':').at(-1)!, nonce: clock, userId: 1, strategyId: 9, state, record: { key }, updatedAt: new Date(clock) })
    .onConflictDoUpdate({ target: schema.copyLiveExecutions.key, set: { state } });
}
/** A filled order the double "sent": journal row plus exchange timings. */
const filled: Runtime = async (request, hooks) => {
  runtimeCalls.push(request);
  const key = keyOf(request.sourceFillId, request.leg);
  hooks.onExchange?.({ phase: 'request', at: clock + 10 }); hooks.onExchange?.({ phase: 'response', at: clock + 40 });
  await journal(key, 'filled');
  return { key, state: 'filled' } as LiveExecutionRecord;
};

function engine(extra: Partial<LiveEngineDependencies> = {}) {
  return new CopyLiveEngine({
    network: 'testnet', repository: new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig()), sources: new CopyLiveSourceRepository(db), uow: new UnitOfWork(db),
    watched: new WatchedMainnetSource(db, () => clock),
    testnetSource: { read: vi.fn(async () => { throw new Error('no testnet source in this test'); }) } as never,
    runtime: hooks => ({ execute: request => runtimeImpl(request, hooks) }),
    settler: { settle: async request => { settleCalls.push(request); return settleImpl(request); } },
    ...extra,
  }, { testnetSourceIntervalMs: 60_000, sourceLagMs: 0, passBudgetMs: 60_000 }, () => clock);
}
/** The leader's REST-confirmed mainnet fill, as the market watcher stores it. */
async function leaderFill(tid: number, time: number, side: 'B' | 'A', sz: string, startPosition: string, coin = 'BTC') {
  const raw = { coin, px: '100', sz, side, time, startPosition, dir: side === 'B' ? 'Open Long' : 'Close Long', closedPnl: '0', hash: `0x${'12'.repeat(32)}`,
    oid: 1000 + tid, crossed: true, fee: '0.01', tid, feeToken: 'USDC' };
  await db.insert(schema.fills).values({ address: leader, tid: BigInt(tid), coin, side, dir: raw.dir, px: '100', sz, fee: '0.01', hash: raw.hash, ts: new Date(time), raw });
  return `mainnet:${leader}:${tid}`;
}
async function coverage(from: number, through: number) {
  await db.insert(schema.fillCoverage).values({ address: leader, verifiedFrom: new Date(from), verifiedThrough: new Date(through), backfillFloor: new Date(from) })
    .onConflictDoUpdate({ target: [schema.fillCoverage.chain, schema.fillCoverage.address], set: { verifiedThrough: new Date(through) } });
}
async function credit() {
  await db.insert(schema.copyFundingOperations).values({ id: 'fund', userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: 'fund-key-0000000001', network: 'testnet',
    address: `0x${'55'.repeat(20)}`, destination: seed.f.identity.accountAddress, amount: '100', nonce: 1, status: 'credited', claimedAt: new Date(now - 9000), attemptedAt: new Date(now - 9000),
    evidenceHash: 'a'.repeat(64), transactionHash: `0x${'b'.repeat(64)}`, creditedAmount: '99', fee: '1' });
}
const dispatches = () => db.select().from(schema.copyLiveDispatches).orderBy(schema.copyLiveDispatches.leaderTime, schema.copyLiveDispatches.leg);

beforeEach(async () => {
  db = getTestDb(); seed = await preparationFixture(db); clock = now;
  // Re-point the fixture's generation at a MAINNET leader, paused until funded.
  const consent = { ...seed.consent, sourceNetwork: 'mainnet' as const };
  await db.update(schema.copyLiveStrategyConfigs).set({ sourceNetwork: 'mainnet' });
  await db.update(schema.copyLiveMandates).set({ sourceNetwork: 'mainnet', intent: consent, intentDigest: mandateDigest(consent) });
  await db.delete(schema.copyLiveSourceFills); await db.delete(schema.copyLiveSourceStreams);
  await db.update(schema.copyStrategies).set({ status: 'paused', pauseNewRisk: true });
  // The owner's approval leaves the generation awaiting its start.
  await db.insert(schema.copyLiveActivations).values({ mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', state: 'pending', controlRevision: 0, requestedAt: new Date(now - 2000) });
  runtimeCalls.length = 0; settleCalls.length = 0; runtimeImpl = filled; settleImpl = async () => ({ kind: 'released' });
});
afterAll(async () => { await closeTestDb(); });

describe('testnet copy execution engine', () => {
  it('starts a generation only once it is funded, and never copies fills from before the start', async () => {
    await coverage(now - 10_000, now); await leaderFill(1, now - 500, 'B', '1', '0');
    await engine().tick();
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'paused', pauseNewRisk: true });
    expect(await db.select().from(schema.copyLiveActivations)).toMatchObject([{ state: 'pending', activatedAt: null }]);
    await credit(); clock = now + 1000; await engine().tick();
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'active', pauseNewRisk: false });
    expect(await db.select().from(schema.copyLiveActivations)).toMatchObject([{ state: 'activated' }]);
    // The pre-activation fill was ingested but is not a signal for this copy.
    expect(await db.select().from(schema.copyLiveSourceFills)).toHaveLength(1);
    expect(await dispatches()).toHaveLength(0); expect(runtimeCalls).toHaveLength(0);
  });

  it('never starts a strategy that a control paused after approval, nor one without a pending start', async () => {
    await credit(); await coverage(now - 10_000, now);
    // A strategy-level pause (as the admin's control command does) advances the control revision.
    await db.update(schema.copyStrategies).set({ pauseNewRisk: true, controlRevision: 1 });
    await engine().tick();
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'paused', pauseNewRisk: true });
    await db.update(schema.copyStrategies).set({ controlRevision: 0 });
    for (const scope of ['platform', 'user'] as const) {
      await db.update(schema.copyControls).set({ pauseNewRisk: true }).where(eq(schema.copyControls.scope, scope));
      await engine().tick();
      expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'paused' });
      await db.update(schema.copyControls).set({ pauseNewRisk: false }).where(eq(schema.copyControls.scope, scope));
    }
    await db.delete(schema.copyLiveActivations); await engine().tick();
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'paused' });
    await db.insert(schema.copyLiveActivations).values({ mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', state: 'pending', controlRevision: 0, requestedAt: new Date(now - 2000) });
    await engine().tick();
    expect((await db.select().from(schema.copyStrategies))[0]).toMatchObject({ status: 'active', pauseNewRisk: false, controlRevision: 1 });
    expect((await db.select().from(schema.copyLiveActivations))[0]).toMatchObject({ state: 'activated' });
  });

  it('a stale pass cannot move a work row out of a terminal state', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const fill = await leaderFill(10, now + 100, 'B', '1', '0');
    clock = now + 1000; await engine().tick();
    const repository = new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig()), [row] = await dispatches();
    await db.update(schema.copyLiveDispatches).set({ state: 'settled', settledAt: new Date(clock) });
    expect(await repository.update({ ...row!, state: 'submitted' }, { state: 'refused', reason: 'late_writer' })).toBe(false);
    expect(await repository.update({ ...row!, state: 'pending' }, { attempts: 99 })).toBe(false);
    expect((await dispatches())[0]).toMatchObject({ sourceFillId: fill, state: 'settled', reason: null });
  });

  it('two passes that read the same attempt cannot both count it, nor overwrite each other\'s reason', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    await leaderFill(11, now + 100, 'B', '1', '0');
    clock = now + 1000; await engine().tick();
    const repository = new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig());
    await db.update(schema.copyLiveDispatches).set({ state: 'pending', attempts: 1, reason: 'exchange_busy' });
    const [read] = await dispatches();
    expect(await repository.update(read!, { attempts: read!.attempts + 1, reason: 'exchange_timeout' })).toBe(true);
    // The second pass still holds the row as it was before the first wrote.
    expect(await repository.update(read!, { attempts: read!.attempts + 1, reason: 'exchange_busy' })).toBe(false);
    expect((await dispatches())[0]).toMatchObject({ state: 'pending', attempts: 2, reason: 'exchange_timeout' });
    // A pass that read the row after the first write moves it on.
    const [fresh] = await dispatches();
    expect(await repository.update(fresh!, { attempts: fresh!.attempts + 1, reason: null })).toBe(true);
    expect((await dispatches())[0]).toMatchObject({ attempts: 3, reason: null });
  });

  it('ingests only the span the watcher proved, then mirrors each new leg once with its latency timings', async () => {
    await credit(); await coverage(now - 10_000, now); await engine().tick();
    const fill = await leaderFill(2, now + 500, 'B', '1', '0');
    clock = now + 1000; await engine().tick();
    expect(await dispatches()).toHaveLength(0); // coverage still ends at `now`
    await coverage(now - 10_000, now + 900); clock = now + 1200; await engine().tick();
    const stream = (await db.select().from(schema.copyLiveSourceStreams))[0]!;
    expect(stream).toMatchObject({ network: 'mainnet', state: 'ready' });
    expect(stream.coverageThrough!.getTime()).toBe(now + 900);
    const [row] = await dispatches();
    expect(row).toMatchObject({ sourceFillId: fill, leg: 'open', state: 'submitted', attempts: 1, executionKey: keyOf(fill, 'open') });
    expect(row!.leaderTime.getTime()).toBe(now + 500); expect(row!.sentAt!.getTime()).toBe(clock + 10); expect(row!.ackedAt!.getTime()).toBe(clock + 40);
    expect(runtimeCalls).toEqual([{ userId: 1, accountId: 'account', mandateId: 'mandate', sourceFillId: fill, leg: 'open', signalDeadline: expect.any(Number) }]);
    clock += 3000; await engine().tick();
    expect((await dispatches())[0]).toMatchObject({ state: 'settled' }); expect(settleCalls).toHaveLength(1);
    clock += 3000; await engine().tick();
    expect(runtimeCalls).toHaveLength(1); expect(settleCalls).toHaveLength(1);
  });

  it('refuses a price-deviation open for good but retries a transient refusal until the signal is too old', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const deviating = await leaderFill(3, now + 100, 'B', '1', '0', 'BTC'), transient = await leaderFill(4, now + 200, 'B', '1', '0', 'ETH');
    runtimeImpl = async request => { runtimeCalls.push(request); throw new LiveBoundaryError(request.sourceFillId === deviating ? 'live_source_price_deviation' : 'live_risk_stale'); };
    clock = now + 1000; await engine().tick();
    let rows = await dispatches();
    expect(rows.find(r => r.sourceFillId === deviating)).toMatchObject({ state: 'refused', reason: 'live_source_price_deviation', attempts: 1 });
    expect(rows.find(r => r.sourceFillId === transient)).toMatchObject({ state: 'pending', reason: 'live_risk_stale', attempts: 1 });
    clock = now + 2000; await engine().tick();
    expect((await dispatches()).find(r => r.sourceFillId === transient)).toMatchObject({ state: 'pending', attempts: 2 });
    clock = now + 200 + 120_001; await engine().tick();
    rows = await dispatches();
    expect(rows.find(r => r.sourceFillId === transient)).toMatchObject({ state: 'refused', reason: 'live_risk_stale', attempts: 2 });
    expect(runtimeCalls.filter(c => c.sourceFillId === deviating)).toHaveLength(1);
  });

  it('refuses an open for good once the runtime could not bring the leverage under the cap, never retrying it', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const above = await leaderFill(13, now + 100, 'B', '1', '0', 'BTC'), rejected = await leaderFill(14, now + 200, 'B', '1', '0', 'ETH');
    runtimeImpl = async request => { runtimeCalls.push(request); throw new LiveBoundaryError(request.sourceFillId === above ? 'live_risk_leverage' : 'live_leverage_update_rejected'); };
    clock = now + 1000; await engine().tick(); clock = now + 2000; await engine().tick();
    const rows = await dispatches();
    expect(rows.find(r => r.sourceFillId === above)).toMatchObject({ state: 'refused', reason: 'live_risk_leverage', attempts: 1 });
    expect(rows.find(r => r.sourceFillId === rejected)).toMatchObject({ state: 'refused', reason: 'live_leverage_update_rejected', attempts: 1 });
    expect(runtimeCalls).toHaveLength(2);
  });

  it('refuses a leg whose journal was rejected before its hold (never sent), instead of waiting on a settlement forever', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const fill = await leaderFill(15, now + 100, 'B', '1', '0');
    runtimeImpl = async request => { runtimeCalls.push(request); await journal(keyOf(fill, 'open'), 'rejected'); throw new LiveBoundaryError('available_collateral'); };
    settleImpl = async () => ({ kind: 'unsent', reason: 'available_collateral' });
    clock = now + 1000; await engine().tick();
    expect((await dispatches())[0]).toMatchObject({ state: 'submitted', executionKey: keyOf(fill, 'open') });
    clock += 3000; await engine().tick();
    expect((await dispatches())[0]).toMatchObject({ state: 'refused', reason: 'available_collateral' });
    expect(runtimeCalls).toHaveLength(1);
  });

  it('sends a leader\'s close however late (CP-EXE-14-02), with no signal deadline, where an open that old is refused', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const open = await leaderFill(16, now + 100, 'B', '1', '0', 'ETH'), close = await leaderFill(17, now + 200, 'A', '1', '1', 'ETH');
    const late = await leaderFill(18, now + 300, 'B', '1', '0', 'BTC');
    runtimeImpl = async (request, hooks) => { if (request.sourceFillId === open) return filled(request, hooks); runtimeCalls.push(request); throw new LiveBoundaryError('live_risk_stale'); };
    clock = now + 1000; await engine().tick(); clock += 3000; await engine().tick();
    expect((await dispatches()).find(r => r.sourceFillId === open)).toMatchObject({ state: 'settled' });
    runtimeCalls.length = 0; runtimeImpl = filled;
    clock = now + 300 + 600_000; await engine().tick();
    const rows = await dispatches();
    expect(rows.find(r => r.sourceFillId === close)).toMatchObject({ state: 'submitted', executionKey: keyOf(close, 'close') });
    expect(rows.find(r => r.sourceFillId === late)).toMatchObject({ state: 'refused' });
    expect(runtimeCalls).toEqual([{ userId: 1, accountId: 'account', mandateId: 'mandate', sourceFillId: close, leg: 'close' }]);
  });

  it('refuses a close that keeps failing after CLOSE_ATTEMPT_LIMIT attempts, never retrying it for ever', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const open = await leaderFill(25, now + 100, 'B', '1', '0', 'ETH'), close = await leaderFill(26, now + 200, 'A', '1', '1', 'ETH');
    runtimeImpl = async (request, hooks) => { if (request.sourceFillId === open) return filled(request, hooks); runtimeCalls.push(request); throw new LiveBoundaryError('live_risk_stale'); };
    clock = now + 1000; await engine().tick();
    await db.update(schema.copyLiveDispatches).set({ attempts: CLOSE_ATTEMPT_LIMIT - 1 }).where(eq(schema.copyLiveDispatches.sourceFillId, close));
    clock = now + 1_000_000; await engine().tick();
    expect((await dispatches()).find(r => r.sourceFillId === close)).toMatchObject({ state: 'refused', reason: 'live_risk_stale', attempts: CLOSE_ATTEMPT_LIMIT });
  });

  it('ends a later close once fresh runtime evidence proves the follower already flat, without another retry', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const open = await leaderFill(60, now + 100, 'B', '1', '0', 'ETH'), close = await leaderFill(61, now + 200, 'A', '1', '1', 'ETH');
    runtimeImpl = async (request, hooks) => {
      if (request.sourceFillId === open) return filled(request, hooks);
      runtimeCalls.push(request); throw new LiveBoundaryError('no_follower_position');
    };
    const worker = engine();
    for (const offset of [1000, 2000, 3000]) { clock = now + offset; await worker.tick(); }
    expect((await dispatches()).find(r => r.sourceFillId === close)).toMatchObject({ state: 'refused', reason: 'no_follower_position', attempts: 1 });
    expect(runtimeCalls.filter(r => r.sourceFillId === close)).toHaveLength(1);
  });

  it('keeps an open with a no-position runtime reason retryable', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const open = await leaderFill(62, now + 100, 'B', '1', '0', 'ETH');
    runtimeImpl = async request => { runtimeCalls.push(request); throw new LiveBoundaryError('no_follower_position'); };
    const worker = engine();
    for (const offset of [1000, 2000]) { clock = now + offset; await worker.tick(); }
    expect((await dispatches()).find(r => r.sourceFillId === open)).toMatchObject({ state: 'pending', attempts: 2 });
  });

  it('keeps an attempted close journal in reconciliation despite a no-position runtime reason', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const open = await leaderFill(63, now + 100, 'B', '1', '0', 'ETH'), close = await leaderFill(64, now + 200, 'A', '1', '1', 'ETH');
    runtimeImpl = async (request, hooks) => {
      if (request.sourceFillId === open) return filled(request, hooks);
      runtimeCalls.push(request); await journal(keyOf(close, 'close'), 'unknown');
      throw new LiveBoundaryError('no_follower_position');
    };
    const worker = engine();
    for (const offset of [1000, 2000]) { clock = now + offset; await worker.tick(); }
    expect((await dispatches()).find(r => r.sourceFillId === close)).toMatchObject({ state: 'submitted', executionKey: keyOf(close, 'close') });
  });

  it('closes what the follower still holds once the leader is flat: a close settled owing part of it, or refused', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const btcOpen = await leaderFill(19, now + 100, 'B', '1', '0', 'BTC'), btcClose = await leaderFill(20, now + 200, 'A', '1', '1', 'BTC');
    const ethOpen = await leaderFill(21, now + 300, 'B', '1', '0', 'ETH'), ethClose = await leaderFill(22, now + 400, 'A', '1', '1', 'ETH');
    const solOpen = await leaderFill(23, now + 500, 'B', '1', '0', 'SOL'), solClose = await leaderFill(24, now + 600, 'A', '1', '1', 'SOL');
    runtimeImpl = async (request, hooks) => {
      if (request.sourceFillId === ethClose) { runtimeCalls.push(request); throw new LiveBoundaryError('below_min_notional'); }
      clock++; return filled(request, hooks); // one nonce per journal
    };
    clock = now + 1000; await engine().tick(); clock += 3000; await engine().tick(); clock += 3000; await engine().tick();
    // BTC: the IOC close left 0.4 unfilled (the settled carry); SOL: closed in full.
    await db.insert(schema.copyLiveReductionCarry).values([{ mandateId: 'mandate', coin: 'BTC', carry: '0.4', revision: 2, updatedAt: new Date(clock) },
      { mandateId: 'mandate', coin: 'SOL', carry: '0', revision: 2, updatedAt: new Date(clock) }]);
    const rows = await dispatches();
    for (const [fill, state] of [[btcOpen, 'settled'], [btcClose, 'settled'], [ethOpen, 'settled'], [ethClose, 'refused'], [solOpen, 'settled'], [solClose, 'settled']] as const)
      expect(rows.find(r => r.sourceFillId === fill)).toMatchObject({ state });
    clock += 3000; await engine().tick(); clock += 3000; await engine().tick();
    const closes = await db.select().from(schema.copyLiveManualCloses);
    expect(closes.map(c => c.coin).sort()).toEqual(['BTC', 'ETH']);
    expect(closes.every(c => c.state === 'requested' && c.accountId === 'account' && c.idempotencyKey.startsWith('reconcile:'))).toBe(true);
  });

  it('skips a close of a position this copy never opened and orders a flip: close settles before the open is sent', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const orphanClose = await leaderFill(5, now + 100, 'A', '1', '2', 'ETH');
    const open = await leaderFill(6, now + 200, 'B', '2', '0');
    clock = now + 1000; await engine().tick();
    expect((await dispatches()).find(r => r.sourceFillId === orphanClose)).toMatchObject({ state: 'refused', reason: 'no_follower_position' });
    // Leader flips long 2 → short 1: a close leg and an open leg.
    const flip = await leaderFill(7, now + 1500, 'A', '3', '2');
    settleImpl = async request => request.key === keyOf(flip, 'close') ? { kind: 'pending', reason: 'live_settlement_terminal_unproven' } : { kind: 'released' };
    clock = now + 2000; await engine().tick();
    let rows = (await dispatches()).filter(r => r.sourceFillId === flip);
    expect(rows.find(r => r.leg === 'close')).toMatchObject({ state: 'submitted' });
    expect(rows.find(r => r.leg === 'open')).toMatchObject({ state: 'pending', attempts: 0 });
    clock += 3000; await engine().tick();
    expect((await dispatches()).find(r => r.sourceFillId === flip && r.leg === 'open')).toMatchObject({ state: 'pending', attempts: 0 });
    settleImpl = async () => ({ kind: 'released' });
    clock += 3000; await engine().tick(); clock += 3000; await engine().tick();
    rows = (await dispatches()).filter(r => r.sourceFillId === flip);
    expect(rows.find(r => r.leg === 'close')).toMatchObject({ state: 'settled' });
    expect(rows.find(r => r.leg === 'open')).toMatchObject({ state: 'settled' });
    const order = runtimeCalls.filter(c => c.sourceFillId === flip).map(c => c.leg);
    expect(order).toEqual(['close', 'open']);
    expect(runtimeCalls.some(c => c.sourceFillId === open)).toBe(true);
  });

  it('after a restart, an order left unknown is only reconciled; a journal found for a pending leg is never sent again', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const fill = await leaderFill(8, now + 100, 'B', '1', '0');
    // The previous worker died after the exchange boundary: journal `unknown`, row still pending.
    await engine().enqueue((await new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig()).mandates(clock))[0]!);
    await journal(keyOf(fill, 'open'), 'unknown');
    runtimeImpl = async request => { runtimeCalls.push(request); return { key: keyOf(fill, 'open'), state: 'unknown' } as LiveExecutionRecord; };
    clock = now + 1000; await engine().tick();
    expect((await dispatches())[0]).toMatchObject({ state: 'submitted', executionKey: keyOf(fill, 'open') });
    expect(runtimeCalls).toHaveLength(0); // the pass only adopted the journal
    clock += 3000; await engine().tick();
    expect(runtimeCalls).toHaveLength(1); // reconciliation through the runtime's existing-key path
    expect(settleCalls).toHaveLength(0);
    await journal(keyOf(fill, 'open'), 'partial'); clock += 3000; await engine().tick();
    expect(settleCalls).toHaveLength(1); expect((await dispatches())[0]).toMatchObject({ state: 'settled' });
  });

  it('a POST that began and then failed leaves the leg submitted for reconciliation, never pending', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const fill = await leaderFill(9, now + 100, 'B', '1', '0');
    runtimeImpl = async (request, hooks) => { runtimeCalls.push(request); hooks.onExchange?.({ phase: 'request', at: clock }); await journal(keyOf(fill, 'open'), 'unknown'); throw new LiveBoundaryError('exchange_submission_ambiguous'); };
    clock = now + 1000; await engine().tick();
    expect((await dispatches())[0]).toMatchObject({ state: 'submitted', reason: 'exchange_submission_ambiguous', executionKey: keyOf(fill, 'open') });
    expect((await dispatches())[0]!.sentAt!.getTime()).toBe(clock);
  });

  it('restarts a stale stream at the new cursor instead of reading the idle gap', async () => {
    await db.insert(schema.copyLiveSourceStreams).values({ id: `mainnet:${leader}`, network: 'mainnet', leaderAddress: leader, state: 'ready',
      coverageFrom: new Date(now - 900_000), coverageThrough: new Date(now - 800_000), coverageDigest: 'c'.repeat(64) });
    await coverage(now - 10_000, now + 500); clock = now + 1000; await engine().tick();
    const [stream] = await db.select().from(schema.copyLiveSourceStreams).where(eq(schema.copyLiveSourceStreams.id, `mainnet:${leader}`));
    expect(stream).toMatchObject({ state: 'ready' });
    expect(stream!.coverageFrom!.getTime()).toBe(now - 2000); // the mandate's activation cursor
    expect(stream!.coverageThrough!.getTime()).toBe(now + 500);
  });

  it('refuses a HIP-3 leg for good when it is enqueued, before any evidence read takes weight', async () => {
    await credit(); await coverage(now - 10_000, now + 5000); await engine().tick();
    const fill = await leaderFill(12, now + 100, 'B', '1', '0', 'xyz:TSLA');
    clock = now + 1000; await engine().tick();
    expect(await dispatches()).toMatchObject([{ sourceFillId: fill, state: 'refused', reason: 'live_market_hip3_unsupported', attempts: 0 }]);
    expect(runtimeCalls).toHaveLength(0); // the runtime is what reads (and acquires) evidence
  });
});
