import { testConfig } from './config-test-utils.js';
import * as schema from '@trading-dashboard/shared/database';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { digest as mandateDigest } from '../src/copy/copy-live-mandate-evidence.js';
import { CopyLiveSourceRepository } from '../src/copy/copy-live-source.repository.js';
import { liveSourceExecutionCloid } from '../src/copy/live/postgres-live-preparation.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import type { LiveExecutionRecord } from '../src/copy/live/live-execution.js';
import type { LiveExecutionHooks, LiveExecutionRequest } from '../src/copy/live/live-execution-runtime.js';
import { CopyLiveEngine, type LiveEngineDependencies } from '../src/copy/live-worker/copy-live-engine.js';
import { CopyLiveWorkerRepository } from '../src/copy/live-worker/copy-live-worker.repository.js';
import { WatchedMainnetSource } from '../src/copy/live-worker/watched-mainnet-source.js';
import { planAdjustments, type PendingLeg } from '../src/copy/live-worker/copy-live-adjustments.js';
import { liveCopySettingsDigest } from '../src/copy/copy-live-mandate-consent.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

// The engine with real SQL and the watched mainnet source; the runtime and
// the settler are doubles. Ratio sizing (same-coin legs merge).
let db: TestDb, clock: number, seed: Awaited<ReturnType<typeof preparationFixture>>;
const leader = `0x${'44'.repeat(20)}`;
type Runtime = (request: LiveExecutionRequest, hooks: Pick<LiveExecutionHooks, 'onExchange'>) => Promise<LiveExecutionRecord>;
let runtimeImpl: Runtime, settle: 'released' | 'pending';
const calls: LiveExecutionRequest[] = [];
const keyOf = (fillId: string, leg: 'open' | 'close') => `testnet:${seed.f.identity.accountAddress}:${liveSourceExecutionCloid('mandate', fillId, leg)}`;
const filled: Runtime = async (request, hooks) => {
  calls.push(request);
  const key = keyOf(request.sourceFillId, request.leg);
  hooks.onExchange?.({ phase: 'request', at: clock + 10 }); hooks.onExchange?.({ phase: 'response', at: clock + 40 });
  await db.insert(schema.copyLiveExecutions).values({ key, network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: `0x${'33'.repeat(20)}`,
    cloid: key.split(':').at(-1)!, nonce: clock + calls.length, userId: 1, strategyId: 9, state: 'filled', record: { key }, updatedAt: new Date(clock) });
  return { key, state: 'filled' } as LiveExecutionRecord;
};
function engine(extra: Partial<LiveEngineDependencies> = {}) {
  return new CopyLiveEngine({
    network: 'testnet', repository: new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig()), sources: new CopyLiveSourceRepository(db), uow: new UnitOfWork(db),
    watched: new WatchedMainnetSource(db, () => clock),
    testnetSource: { read: vi.fn(async () => { throw new Error('no testnet source in this test'); }) } as never,
    runtime: hooks => ({ execute: request => runtimeImpl(request, hooks) }),
    settler: { settle: async () => settle === 'released' ? { kind: 'released' } : { kind: 'pending', reason: 'live_settlement_terminal_unproven' } },
    ...extra,
  }, { testnetSourceIntervalMs: 60_000, sourceLagMs: 0, passBudgetMs: 60_000 }, () => clock);
}
/** The leader's REST-confirmed mainnet fill, as the market watcher stores it. */
async function leaderFill(tid: number, time: number, side: 'B' | 'A', sz: string, startPosition: string, coin = 'BTC') {
  const raw = { coin, px: '100', sz, side, time, startPosition, dir: 'Trade', closedPnl: '0', hash: `0x${'12'.repeat(32)}`, oid: 1000 + tid, crossed: true, fee: '0.01', tid, feeToken: 'USDC' };
  await db.insert(schema.fills).values({ address: leader, tid: BigInt(tid), coin, side, dir: raw.dir, px: '100', sz, fee: '0.01', hash: raw.hash, ts: new Date(time), raw });
  return `mainnet:${leader}:${tid}`;
}
async function coverage(from: number, through: number) {
  await db.insert(schema.fillCoverage).values({ address: leader, verifiedFrom: new Date(from), verifiedThrough: new Date(through), backfillFloor: new Date(from) })
    .onConflictDoUpdate({ target: [schema.fillCoverage.chain, schema.fillCoverage.address], set: { verifiedThrough: new Date(through) } });
}
const dispatches = () => db.select().from(schema.copyLiveDispatches).orderBy(schema.copyLiveDispatches.leaderTime, schema.copyLiveDispatches.id);

beforeEach(async () => {
  db = getTestDb(); seed = await preparationFixture(db, 'ratio'); clock = now;
  const consent = { ...seed.consent, sourceNetwork: 'mainnet' as const };
  await db.update(schema.copyLiveStrategyConfigs).set({ sourceNetwork: 'mainnet' });
  await db.update(schema.copyLiveMandates).set({ sourceNetwork: 'mainnet', intent: consent, intentDigest: mandateDigest(consent) });
  await db.delete(schema.copyLiveSourceFills); await db.delete(schema.copyLiveSourceStreams);
  await db.insert(schema.copyFundingOperations).values({ id: 'fund', userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: 'fund-key-0000000001', network: 'testnet',
    address: `0x${'55'.repeat(20)}`, destination: seed.f.identity.accountAddress, amount: '100', nonce: 1, status: 'credited', claimedAt: new Date(now - 9000), attemptedAt: new Date(now - 9000),
    evidenceHash: 'a'.repeat(64), transactionHash: `0x${'b'.repeat(64)}`, creditedAmount: '99', fee: '1' });
  // Approved and funded: the first pass starts it (fills after now are copied).
  await db.update(schema.copyStrategies).set({ status: 'paused', pauseNewRisk: true });
  await db.insert(schema.copyLiveActivations).values({ mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', state: 'pending', controlRevision: 0, requestedAt: new Date(now - 2000) });
  calls.length = 0; runtimeImpl = filled; settle = 'released';
  await coverage(now - 10_000, now); await engine().tick();
  expect(await db.select().from(schema.copyLiveActivations)).toMatchObject([{ state: 'activated' }]);
});
afterAll(async () => { await closeTestDb(); });

describe('same-coin leader legs become one follower adjustment', () => {
  it('the copy is ratio-sized', async () => {
    const [version] = await db.select().from(schema.copyStrategyVersions);
    expect(version!.settings).toMatchObject({ sizingMode: 'ratio' });
    expect(seed.consent.settingsDigest).toBe(liveCopySettingsDigest(version!.settings as never));
  });

  it('five open-short fills that wait together are one order carrying the other four', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await leaderFill(10 + i, now + 100 + i * 100, 'A', '1', String(-i)));
    await coverage(now - 10_000, now + 900); clock = now + 1000; await engine().tick();
    // The newest leg leads (its signal is the order's); it carries the other four.
    expect(calls).toEqual([{ userId: 1, accountId: 'account', mandateId: 'mandate', sourceFillId: ids[4], leg: 'open', members: ids.slice(0, 4), signalDeadline: expect.any(Number) }]);
    const rows = await dispatches(), lead = rows.find(r => r.sourceFillId === ids[4])!;
    expect(lead).toMatchObject({ state: 'submitted', adjustmentId: lead.id, executionKey: keyOf(ids[4]!, 'open') });
    expect(rows.filter(r => r.id !== lead.id)).toEqual(ids.slice(0, 4).map(id => expect.objectContaining({ sourceFillId: id, state: 'refused', reason: 'merged_into_adjustment', adjustmentId: lead.id })));
    // Settles once; no merged leg is ever sent on its own.
    clock += 3000; await engine().tick(); clock += 3000; await engine().tick();
    expect(calls).toHaveLength(1); expect((await dispatches()).find(r => r.id === lead.id)).toMatchObject({ state: 'settled' });
  });

  it('a flip becomes its close, then its open, then the adds after it as one order', async () => {
    const open = await leaderFill(20, now + 100, 'B', '2', '0'); // long 2
    await coverage(now - 10_000, now + 200); clock = now + 300; await engine().tick();
    const flip = await leaderFill(21, now + 400, 'A', '3', '2'); // long 2 -> short 1
    const adds = [await leaderFill(22, now + 500, 'A', '1', '-1'), await leaderFill(23, now + 600, 'A', '1', '-2')];
    settle = 'pending';
    await coverage(now - 10_000, now + 700); clock = now + 800; await engine().tick();
    // The flip's open waits for its close to settle, and the adds after it wait for the open.
    expect(calls.map(c => [c.sourceFillId, c.leg, c.members ?? []])).toEqual([[open, 'open', []], [flip, 'close', []]]);
    settle = 'released'; clock += 3000; await engine().tick(); clock += 3000; await engine().tick();
    expect(calls.map(c => [c.sourceFillId, c.leg, c.members ?? []]).slice(2)).toEqual([[flip, 'open', []], [adds[1], 'open', [adds[0]]]]);
  });

  it('an open too small for the exchange waits for the next adds, then goes as one', async () => {
    // Leader worth 1,000 USDC, copy budget 100: each 0.3 @ 100 add is at most 3 USDC.
    const leaderEquity = vi.fn(async () => '1000');
    const first = [await leaderFill(30, now + 100, 'A', '0.3', '0'), await leaderFill(31, now + 200, 'A', '0.3', '-0.3')];
    await coverage(now - 10_000, now + 300); clock = now + 400; await engine({ leaderEquity }).tick();
    expect(calls).toHaveLength(0);
    expect(await dispatches()).toEqual(first.map(id => expect.objectContaining({ sourceFillId: id, state: 'pending', adjustmentId: null, attempts: 0 })));
    const more = [await leaderFill(32, now + 500, 'A', '0.3', '-0.6'), await leaderFill(33, now + 600, 'A', '0.3', '-0.9'), await leaderFill(34, now + 700, 'A', '0.3', '-1.2')];
    await coverage(now - 10_000, now + 800); clock = now + 900; await engine({ leaderEquity }).tick();
    expect(calls).toEqual([expect.objectContaining({ sourceFillId: more[2], leg: 'open', members: [...first, more[0], more[1]] })]);
  });

  it('held only while its signal is fresh: past the policy\'s signal age (less 15 s) it is dropped, never sent', async () => {
    // Signals expire after 40 s here: a leg may wait at most 25 s.
    const [policy] = await db.select().from(schema.copyRiskPolicies);
    await db.insert(schema.copyRiskPolicies).values({ version: policy!.version + 1, limits: { ...policy!.limits as object, maxSignalAgeSeconds: 40 } });
    const leaderEquity = vi.fn(async () => '1000');
    const only = await leaderFill(40, now + 100, 'A', '0.3', '0');
    await coverage(now - 10_000, now + 200); clock = now + 300; await engine({ leaderEquity }).tick();
    clock = now + 100 + 24_999; await engine({ leaderEquity }).tick();
    expect(calls).toHaveLength(0); expect((await dispatches())[0]).toMatchObject({ sourceFillId: only, state: 'pending' });
    clock = now + 100 + 25_000; await engine({ leaderEquity }).tick();
    expect(calls).toHaveLength(0); expect((await dispatches())[0]).toMatchObject({ sourceFillId: only, state: 'refused', reason: 'merged_signal_expired' });
  });

  it('a merge never carries a leg past the signal age: the aged legs are dropped, the fresh ones go', async () => {
    const [policy] = await db.select().from(schema.copyRiskPolicies);
    await db.insert(schema.copyRiskPolicies).values({ version: policy!.version + 1, limits: { ...policy!.limits as object, maxSignalAgeSeconds: 40 } });
    const leaderEquity = vi.fn(async () => '1000');
    const old = await leaderFill(41, now + 100, 'A', '0.3', '0'); // 3 USDC: held
    await coverage(now - 10_000, now + 200); clock = now + 300; await engine({ leaderEquity }).tick();
    // 26 s later (signal age 40 s, less 15 s), three more adds.
    const fresh: string[] = [];
    for (let i = 0; i < 3; i++) fresh.push(await leaderFill(42 + i, now + 26_000 + i * 10, 'A', '0.3', String(-0.3 * (i + 1))));
    await coverage(now - 10_000, now + 26_100); clock = now + 26_200; await engine({ leaderEquity }).tick();
    expect((await dispatches()).find(r => r.sourceFillId === old)).toMatchObject({ state: 'refused', reason: 'merged_signal_expired' });
    expect(calls).toEqual([]); // without the dropped leg, 3 x 3 USDC is under 11: held
    const more = await leaderFill(46, now + 26_150, 'A', '0.3', '-1.2');
    await coverage(now - 10_000, now + 26_300); clock = now + 26_400; await engine({ leaderEquity }).tick();
    expect(calls).toEqual([expect.objectContaining({ sourceFillId: more, members: fresh })]);
  });

  it('a held open too small when its coin is reduced is refused, without an order; the reduce goes', async () => {
    const leaderEquity = vi.fn(async () => '1000');
    const open = await leaderFill(45, now + 100, 'B', '10', '0'); // 1,000 of leader notional: 100 USDC for this copy
    await coverage(now - 10_000, now + 200); clock = now + 300; await engine({ leaderEquity }).tick();
    const small = await leaderFill(46, now + 400, 'B', '0.3', '10'), reduce = await leaderFill(47, now + 500, 'A', '1', '10.3');
    await coverage(now - 10_000, now + 600); clock = now + 700; await engine({ leaderEquity }).tick();
    expect(calls.map(c => [c.sourceFillId, c.leg])).toEqual([[open, 'open'], [reduce, 'close']]);
    expect((await dispatches()).find(r => r.sourceFillId === small)).toMatchObject({ state: 'refused', reason: 'below_min_notional' });
  });

  it('a merged open the runtime finds below the minimum goes back to waiting, then merges again with the next add', async () => {
    const legs = [await leaderFill(50, now + 100, 'A', '1', '0'), await leaderFill(51, now + 200, 'A', '1', '-1')];
    runtimeImpl = async request => { calls.push(request); throw new LiveBoundaryError('below_min_notional'); };
    await coverage(now - 10_000, now + 300); clock = now + 400; await engine().tick();
    expect(calls).toHaveLength(1);
    expect(await dispatches()).toEqual(legs.map(id => expect.objectContaining({ sourceFillId: id, state: 'pending', adjustmentId: null, reason: 'below_min_notional' })));
    clock += 3000; await engine().tick();
    expect(calls).toHaveLength(1); // the same legs alone are not tried again
    runtimeImpl = filled;
    const next = await leaderFill(52, now + 3500, 'A', '1', '-2');
    await coverage(now - 10_000, now + 3600); clock = now + 3700; await engine().tick();
    expect(calls.at(-1)).toMatchObject({ sourceFillId: next, members: legs });
  });
});

describe('adjustment runs (pure)', () => {
  const leg = (id: number, kind: 'open' | 'close', sign: 1 | -1, flip = false): PendingLeg => ({ id: `d${id}`, sourceFillId: `f${id}`, coin: 'BTC', leg: kind, sign, size: '1', px: '100',
    leaderTime: id, tid: BigInt(id), flip, belowMinimum: false });
  it('keeps leader order: add, reduce, add are three orders; reduces in a row are one', () => {
    const plan = planAdjustments([leg(1, 'open', -1), leg(2, 'open', -1), leg(3, 'close', -1), leg(4, 'close', -1), leg(5, 'open', -1)], 10, 90_000, () => false);
    expect(plan.merges.map(run => run.legs.map(l => l.id))).toEqual([['d1', 'd2'], ['d3', 'd4']]);
    expect(plan.held.size).toBe(0);
  });
  it('never drops a run of reductions for its age (CP-EXE-14-02); an old open run is still dropped', () => {
    const plan = planAdjustments([leg(1, 'close', -1), leg(2, 'close', -1)], 1_000_000, 90_000, () => false);
    expect(plan.expired.size).toBe(0); expect(plan.merges.map(run => run.legs.map(l => l.id))).toEqual([['d1', 'd2']]);
    expect(planAdjustments([leg(1, 'open', -1), leg(2, 'open', -1)], 1_000_000, 90_000, () => false).expired).toEqual(new Set(['d1', 'd2']));
  });
  it('a flip\'s close and open are each their own order; the adds after it merge', () => {
    const plan = planAdjustments([leg(1, 'close', 1), leg(2, 'close', 1, true), leg(2, 'open', -1, true), leg(3, 'open', -1), leg(4, 'open', -1)], 10, 900_000, () => false);
    expect(plan.merges.map(run => run.legs.map(l => `${l.id}:${l.leg}`))).toEqual([['d3:open', 'd4:open']]);
  });
});
