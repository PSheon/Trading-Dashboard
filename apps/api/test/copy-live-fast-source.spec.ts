import { testConfig } from './config-test-utils.js';
import * as schema from '@trading-dashboard/shared/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { digest as mandateDigest } from '../src/copy/copy-live-mandate-evidence.js';
import { CopyLiveSourceRepository } from '../src/copy/copy-live-source.repository.js';
import { liveSourceExecutionCloid } from '../src/copy/live/postgres-live-preparation.js';
import { liveSourceDigest } from '../src/copy/live/copy-live-source-evidence.js';
import type { LiveExecutionRecord } from '../src/copy/live/live-execution.js';
import type { LiveExecutionHooks, LiveExecutionRequest } from '../src/copy/live/live-execution-runtime.js';
import { CopyLiveEngine, type LiveEngineDependencies } from '../src/copy/live-worker/copy-live-engine.js';
import { CopyLiveWorkerRepository } from '../src/copy/live-worker/copy-live-worker.repository.js';
import { WatchedMainnetSource } from '../src/copy/live-worker/watched-mainnet-source.js';
import { FastMainnetSource, type FastSourceReader } from '../src/copy/live-worker/fast-mainnet-source.js';
import { twapSliceToFill } from '../src/hyperliquid/hyperliquid-info.client.js';
import type { HlUserFill } from '../src/hyperliquid/types.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';
import { FOLLOW_UP_MAX_MS, GAP_FOLLOW_UP_EXPIRY_MS } from '../src/config/constants/timings.js';

// Real SQL, sources and repositories; the exchange runtime and settler are
// doubles, the provider is a fake `userFillsByTime` / TWAP reader.
let db: TestDb, clock: number, seed: Awaited<ReturnType<typeof preparationFixture>>;
const leader = `0x${'44'.repeat(20)}`, G = 2000, ZERO = `0x${'00'.repeat(32)}`;
const runtimeCalls: LiveExecutionRequest[] = [];
const keyOf = (fillId: string, leg: 'open' | 'close') => `testnet:${seed.f.identity.accountAddress}:${liveSourceExecutionCloid('mandate', fillId, leg)}`;
const filled = async (request: LiveExecutionRequest, hooks: Pick<LiveExecutionHooks, 'onExchange'>) => {
  runtimeCalls.push(request);
  const key = keyOf(request.sourceFillId, request.leg);
  hooks.onExchange?.({ phase: 'request', at: clock + 10 }); hooks.onExchange?.({ phase: 'response', at: clock + 40 });
  await db.insert(schema.copyLiveExecutions).values({ key, network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: `0x${'33'.repeat(20)}`,
    cloid: key.split(':').at(-1)!, nonce: clock, userId: 1, strategyId: 9, state: 'filled', record: { key }, updatedAt: new Date(clock) });
  return { key, state: 'filled' } as LiveExecutionRecord;
};
/** A REST fill row as Hyperliquid answers `userFillsByTime`. */
function rest(tid: number, time: number, extra: Partial<HlUserFill> = {}): HlUserFill {
  return { coin: 'BTC', px: '100', sz: '1', side: 'B', time, startPosition: '0', dir: 'Open Long', closedPnl: '0', hash: `0x${'12'.repeat(32)}`,
    oid: 1000 + tid, crossed: true, fee: '0.01', tid, feeToken: 'USDC', ...extra } as HlUserFill;
}
/** `budgetWaitMs`: how long each fills read waits for the mainnet budget before it leaves. */
function reader(fills: () => HlUserFill[], slices: () => HlUserFill[] = () => [], budgetWaitMs = 0) {
  const calls: { kind: 'fills' | 'twap'; from: number }[] = [];
  const read: FastSourceReader = {
    fills: async (_leader, from) => { calls.push({ kind: 'fills', from }); clock += budgetWaitMs;
      return { fills: fills().filter(f => f.time >= from && f.time <= clock), sentAt: clock }; },
    twapSlices: async (_leader, from) => { calls.push({ kind: 'twap', from }); return slices().filter(f => f.time >= from && f.time <= clock); },
  };
  return { read, calls };
}
function engine(fast?: FastMainnetSource, extra: Partial<LiveEngineDependencies> = {}) {
  return new CopyLiveEngine({
    network: 'testnet', repository: new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig()), sources: new CopyLiveSourceRepository(db), uow: new UnitOfWork(db),
    watched: new WatchedMainnetSource(db, () => clock),
    testnetSource: { read: vi.fn(async () => { throw new Error('no testnet source in this test'); }) } as never,
    runtime: hooks => ({ execute: request => filled(request, hooks) }),
    settler: { settle: async () => ({ kind: 'released' }) },
    ...(fast ? { fast: { source: fast, leaders: new Set([leader]), feedUp: () => true } } : {}),
    ...extra,
  }, { testnetSourceIntervalMs: 60_000, sourceLagMs: 0, passBudgetMs: 60_000 }, () => clock);
}
async function credit() {
  await db.insert(schema.copyFundingOperations).values({ id: 'fund', userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: 'fund-key-0000000001', network: 'testnet',
    address: `0x${'55'.repeat(20)}`, destination: seed.f.identity.accountAddress, amount: '100', nonce: 1, status: 'credited', claimedAt: new Date(now - 9000), attemptedAt: new Date(now - 9000),
    evidenceHash: 'a'.repeat(64), transactionHash: `0x${'b'.repeat(64)}`, creditedAmount: '99', fee: '1' });
}
/** As the market watcher stores a REST-confirmed fill (`toFillRow`). */
async function watcherFill(raw: HlUserFill) {
  await db.insert(schema.fills).values({ address: leader, tid: BigInt(raw.tid), coin: raw.coin, side: raw.side, dir: raw.dir, px: raw.px, sz: raw.sz, fee: raw.fee,
    hash: /^0x0*$/.test(raw.hash) ? null : raw.hash, ts: new Date(raw.time), raw: raw as unknown as Record<string, unknown> });
}
async function verified(from: number, through: number) {
  await db.insert(schema.fillCoverage).values({ address: leader, verifiedFrom: new Date(from), verifiedThrough: new Date(through), backfillFloor: new Date(from) })
    .onConflictDoUpdate({ target: [schema.fillCoverage.chain, schema.fillCoverage.address], set: { verifiedThrough: new Date(through) } });
}
const stream = async () => (await db.select().from(schema.copyLiveSourceStreams).where(eq(schema.copyLiveSourceStreams.id, `mainnet:${leader}`)))[0]!;
const dispatches = () => db.select().from(schema.copyLiveDispatches).orderBy(schema.copyLiveDispatches.leaderTime, schema.copyLiveDispatches.leg);

beforeEach(async () => {
  db = getTestDb(); seed = await preparationFixture(db); clock = now;
  const consent = { ...seed.consent, sourceNetwork: 'mainnet' as const };
  await db.update(schema.copyLiveStrategyConfigs).set({ sourceNetwork: 'mainnet' });
  await db.update(schema.copyLiveMandates).set({ sourceNetwork: 'mainnet', intent: consent, intentDigest: mandateDigest(consent) });
  await db.delete(schema.copyLiveSourceFills); await db.delete(schema.copyLiveSourceStreams);
  await db.update(schema.copyStrategies).set({ status: 'paused', pauseNewRisk: true });
  await db.insert(schema.copyLiveActivations).values({ mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', state: 'pending', controlRevision: 0, requestedAt: new Date(now - 2000) });
  runtimeCalls.length = 0;
});
afterAll(async () => { await closeTestDb(); });

describe('realtime copy signal (fast mainnet source)', () => {
  it('submits the leg in the kick that read it, while the watched source has nothing', async () => {
    await credit(); await engine().tick(); // activates; no watcher coverage at all
    const fills: HlUserFill[] = [], { read, calls } = reader(() => fills), fast = new FastMainnetSource(read, G, () => clock);
    clock = now + 5000; fills.push(rest(1, clock - 2000));
    expect(await new WatchedMainnetSource(db, () => clock).read(leader, now - 2000, clock)).toBeNull();
    await engine(fast).kick(leader);
    expect(calls).toEqual([{ kind: 'fills', from: now - 2000 }]); // the activation cursor
    expect(await stream()).toMatchObject({ state: 'ready' }); expect((await stream()).coverageThrough!.getTime()).toBe(clock - G);
    const [row] = await dispatches();
    expect(row).toMatchObject({ sourceFillId: `mainnet:${leader}:1`, leg: 'open', state: 'submitted', attempts: 1 });
    expect(row!.receivedAt.getTime() - row!.leaderTime.getTime()).toBe(2000); expect(row!.sentAt!.getTime()).toBe(clock + 10);
    expect(runtimeCalls).toHaveLength(1);
  });

  it('a leader open waits while a close of that coin is requested on the account, then goes (O4)', async () => {
    await credit(); await engine().tick();
    await db.insert(schema.copyLiveManualCloses).values({ id: 'held', userId: 1, accountId: 'account', strategyId: 9, idempotencyKey: 'reconcile:earlier-close', coin: 'BTC',
      createdAt: new Date(now), updatedAt: new Date(now) });
    const fills: HlUserFill[] = [], { read } = reader(() => fills), fast = new FastMainnetSource(read, G, () => clock);
    clock = now + 5000; fills.push(rest(1, clock - 2000));
    await engine(fast).kick(leader);
    expect(await dispatches()).toEqual([expect.objectContaining({ leg: 'open', state: 'pending', attempts: 0 })]); expect(runtimeCalls).toHaveLength(0);
    await db.update(schema.copyLiveManualCloses).set({ state: 'refused', reason: 'leader_reopened' });
    await engine(fast).workLeader(leader);
    expect(await dispatches()).toEqual([expect.objectContaining({ leg: 'open', state: 'submitted', attempts: 1 })]); expect(runtimeCalls).toHaveLength(1);
  });

  it('a pass without a kick leaves a fast leader on the watched source while the feed is up', async () => {
    await credit(); await engine().tick();
    const { read, calls } = reader(() => [rest(1, now + 3000)]), fast = new FastMainnetSource(read, G, () => clock);
    clock = now + 5000; await engine(fast).tick();
    expect(calls).toEqual([]); expect(await dispatches()).toHaveLength(0);
    // Feed down: the pass polls the fast source instead.
    await engine(fast, { fast: { source: fast, leaders: new Set([leader]), feedUp: () => false } }).tick();
    expect(calls).toHaveLength(1); expect(await dispatches()).toHaveLength(1);
  });

  it('keeps coverage below a trade the feed saw that REST has not returned, and picks it up on a later read', async () => {
    const fills: HlUserFill[] = [rest(1, 1000)], { read } = reader(() => fills), fast = new FastMainnetSource(read, G, () => clock);
    clock = 10_000; fast.witness(leader, 2, 4000);
    let result = await fast.read(leader, 500);
    expect(result!.to).toBe(3999); expect(result!.fills.map(f => f.tid)).toEqual(['1']); expect(result!.complete).toBe(true);
    expect(fast.followUp(leader)).toBeGreaterThanOrEqual(4000 + G);
    fills.push(rest(2, 4000)); clock = 11_000;
    result = await fast.read(leader, 4000);
    expect(result!.to).toBe(11_000 - G); expect(result!.fills.map(f => f.tid)).toEqual(['2']);
    expect(fast.followUp(leader)).toBeNull();
  });

  it('a read that left the stream in gap is followed up G after it, backed off while reads keep falling short, and not once the stream is ready (Stage mainnet 2026-10-22 18:02Z)', async () => {
    const fills: HlUserFill[] = [rest(1, 1000)], { read } = reader(() => fills), fast = new FastMainnetSource(read, G, () => clock);
    clock = 10_000; await fast.read(leader, 500);
    // Nothing witnessed and nothing beyond: no follow-up of its own.
    expect(fast.followUp(leader)).toBeNull();
    // The stream fell to gap on this read (slower than the evidence window): read again G after it.
    fast.readOutcome(leader, true);
    expect(fast.followUp(leader)).toBe(10_000 + G); expect(fast.nextReadAt(leader)).toBe(10_000 + G);
    clock = 12_000; await fast.read(leader, 500); fast.readOutcome(leader, true);
    expect(fast.followUp(leader)).toBe(12_000 + G);
    clock = 14_000; await fast.read(leader, 500); fast.readOutcome(leader, true);
    expect(fast.followUp(leader)).toBe(14_000 + 4000);
    clock = 18_000; await fast.read(leader, 500); fast.readOutcome(leader, true);
    expect(fast.followUp(leader)).toBe(18_000 + FOLLOW_UP_MAX_MS);
    // A witnessed trade due sooner than the recovery read wins; the recovery read never waits for one.
    fast.witness(leader, 2, 18_500);
    expect(fast.followUp(leader)).toBe(18_500 + G + 100);
    // Ready again: only what is witnessed asks for a read (the trade REST has not returned yet, a second apart), then nothing.
    clock = 26_000; await fast.read(leader, 500); fast.readOutcome(leader, false);
    expect(fast.followUp(leader)).toBe(26_000 + G);
    fills.push(rest(2, 18_500)); clock = 28_000; await fast.read(leader, 500); fast.readOutcome(leader, false);
    expect(fast.followUp(leader)).toBeNull();
  });

  it('a gap follow-up ends when the engine reports any other outcome, and GAP_FOLLOW_UP_EXPIRY_MS after the first gap read at the latest (review of c888f6c5)', async () => {
    const { read } = reader(() => []), fast = new FastMainnetSource(read, G, () => clock);
    clock = 10_000; await fast.read(leader, 500); fast.readOutcome(leader, true);
    expect(fast.followUp(leader)).toBe(10_000 + G);
    fast.readOutcome(leader, false); expect(fast.followUp(leader)).toBeNull();
    // Reads keep falling short (or none runs at all): the follow-up is bounded by the expiry, measured from the first gap.
    fast.readOutcome(leader, true);
    clock = 10_000 + GAP_FOLLOW_UP_EXPIRY_MS; expect(fast.followUp(leader)).toBe(10_000 + G);
    clock += 1; expect(fast.followUp(leader)).toBeNull();
  });

  /** The worker service's loop (schedule -> signal -> followUp), simulated: how many signals until no follow-up is due (at most 20). */
  async function drain(worker: CopyLiveEngine) {
    let signals = 0;
    for (let next = worker.followUp(leader); next !== null && signals < 20; next = worker.followUp(leader)) { clock = Math.max(clock, next); await worker.signal(leader); signals++; }
    return signals;
  }
  /** A fast source whose first read answers 5.16 s late (the incident), the rest at once. */
  function slowOnceSource() {
    const { read } = reader(() => [rest(1, now + 3000)]); let slowOnce = true;
    const slow: FastSourceReader = { ...read, fills: async (l, from) => { const answer = await read.fills(l, from); if (slowOnce) { slowOnce = false; clock += 5160; } return answer; } };
    return new FastMainnetSource(slow, G, () => clock);
  }
  it('no hot loop after a gap read: a stream quarantined before the follow-up ends it (review of c888f6c5: a 0 ms timer fired until restart)', async () => {
    await credit(); await engine().tick();
    const fast = slowOnceSource(), worker = engine(fast);
    clock = now + 6000; await worker.kick(leader);
    expect((await db.select().from(schema.copyLiveSourceStreams))[0]).toMatchObject({ state: 'gap' }); expect(worker.followUp(leader)).toBe(now + 6000 + 5160 + G);
    await db.update(schema.copyLiveSourceStreams).set({ state: 'quarantined', lastIssue: 'invalid_fill' });
    expect(await drain(worker)).toBe(1); expect(worker.followUp(leader)).toBeNull();
  });
  it('no hot loop after a gap read: a leader whose copy is gone ends it; one whose reads keep failing backs off and ends at the expiry', async () => {
    await credit(); await engine().tick();
    const fast = slowOnceSource(), worker = engine(fast);
    clock = now + 6000; await worker.kick(leader);
    expect(worker.followUp(leader)).toBe(now + 6000 + 5160 + G);
    // The copy's generation expires (well before the follow-up's own expiry): no stream to read for this leader.
    await db.update(schema.copyLiveMandates).set({ expiresAt: new Date(now + 40_000) });
    clock = now + 41_000;
    expect(await drain(worker)).toBe(1); expect(worker.followUp(leader)).toBeNull();
    // A read that throws every time: counted as a gap, backed off (G, G, 4 s, 8 s, ...), over within the expiry.
    await db.update(schema.copyLiveMandates).set({ expiresAt: new Date(now + 600_000) });
    const failing = new FastMainnetSource({ ...reader(() => []).read, fills: async () => { throw new Error('fast source down'); } }, G, () => clock), broken = engine(failing);
    clock = now + 50_000; await broken.kick(leader);
    const first = broken.followUp(leader); expect(first).toBe(now + 50_000 + G);
    const signals = await drain(broken);
    expect(signals).toBeGreaterThan(1); expect(signals).toBeLessThan(20); expect(broken.followUp(leader)).toBeNull();
    expect(clock - (now + 50_000)).toBeLessThanOrEqual(GAP_FOLLOW_UP_EXPIRY_MS + FOLLOW_UP_MAX_MS);
  });

  it('no hot loop after a gap read: a throw before the read (ensure) or after it (apply) counts as a gap, so the follow-up backs off and ends (review of 078c7e94)', async () => {
    await credit(); await engine().tick();
    const fast = slowOnceSource(), worker = engine(fast);
    clock = now + 6000; await worker.kick(leader);
    expect(worker.followUp(leader)).toBe(now + 6000 + 5160 + G);
    // The stream row cannot be locked: nothing is read, lastReadAt stays, yet the follow-up must not fire at 0 ms for ever.
    const ensure = vi.spyOn(CopyLiveSourceRepository.prototype, 'ensure').mockRejectedValue(new Error('database down'));
    try {
      const before = clock, signals = await drain(worker);
      expect(signals).toBeGreaterThan(1); expect(signals).toBeLessThan(12); expect(worker.followUp(leader)).toBeNull();
      expect(clock - before).toBeLessThanOrEqual(GAP_FOLLOW_UP_EXPIRY_MS + FOLLOW_UP_MAX_MS);
    } finally { ensure.mockRestore(); }
    // A read that lands but whose apply throws: the same back-off (before: every G, thirty follow-ups a minute).
    await db.update(schema.copyLiveMandates).set({ expiresAt: new Date(now + 600_000) });
    const other = slowOnceSource(), again = engine(other);
    clock = now + 120_000; await again.kick(leader);
    expect(again.followUp(leader)).toBe(now + 120_000 + 5160 + G);
    const apply = vi.spyOn(CopyLiveSourceRepository.prototype, 'apply').mockRejectedValue(new Error('database down'));
    try {
      const asked = await drain(again);
      expect(asked).toBeGreaterThan(1); expect(asked).toBeLessThan(12); expect(again.followUp(leader)).toBeNull();
    } finally { apply.mockRestore(); }
  });

  it('the engine reports a fast read\'s outcome: a read slower than the evidence window puts the stream in gap and asks for a follow-up read G later', async () => {
    await credit(); await engine().tick();
    // The read leaves at once but its answer takes 5.16 s (the incident): fresh is false, the stream goes to gap (source_unavailable).
    const { read } = reader(() => [rest(1, now + 3000)]); let slowOnce = true;
    const slow: FastSourceReader = { ...read, fills: async (l, from) => { const answer = await read.fills(l, from); if (slowOnce) { slowOnce = false; clock += 5160; } return answer; } };
    const fast = new FastMainnetSource(slow, G, () => clock), worker = engine(fast);
    clock = now + 6000; await worker.kick(leader);
    const readAt = now + 6000;
    expect((await db.select().from(schema.copyLiveSourceStreams))[0]).toMatchObject({ state: 'gap', lastIssue: 'source_unavailable' });
    // G after the gap was noted (the read answered 5.16 s after it was asked), never a time already past.
    expect(worker.followUp(leader)).toBe(readAt + 5160 + G);
    // The follow-up read answers in time: ready, and nothing more to follow up.
    clock += G; await worker.kick(leader);
    expect((await db.select().from(schema.copyLiveSourceStreams))[0]).toMatchObject({ state: 'ready', lastIssue: null });
    expect(worker.followUp(leader)).toBeNull();
  });

  it('certifies that much less when our clock runs ahead of Hyperliquid\'s (O9)', async () => {
    const { read } = reader(() => [rest(1, 1000)]);
    clock = 10_000; expect((await new FastMainnetSource(read, G, () => clock).read(leader, 500))!.to).toBe(8000);
    expect((await new FastMainnetSource(read, G, () => clock, undefined, () => 1500).read(leader, 500))!.to).toBe(6500);
    // Behind (negative) never certifies more than G allows.
    expect((await new FastMainnetSource(read, G, () => clock, undefined, () => -1500).read(leader, 500))!.to).toBe(8000);
  });
  it('a spot fill in the mainnet answer is skipped, not a failed read', async () => {
    const spot = rest(3, 2000, { coin: '@107', dir: 'Buy' } as Partial<HlUserFill>), perp = rest(4, 2500);
    const { read } = reader(() => [spot, perp]), fast = new FastMainnetSource(read, G, () => clock);
    clock = 10_000; fast.witness(leader, 3, 2000);
    const result = await fast.read(leader, 1000);
    expect(result!.complete).toBe(true); expect(result!.to).toBe(8000); expect(result!.fills.map(f => f.tid)).toEqual(['4']);
    await new UnitOfWork(db).run(async tx => {
      const sources = new CopyLiveSourceRepository(db), current = await sources.ensure(tx, leader, 'mainnet');
      expect((await sources.apply(tx, current.revision, result!, clock)).kind).toBe('recorded');
    });
  });

  it('reads TWAP slices when a zero-hash fill appears, and stores them as the watcher does', async () => {
    const slice = { twapId: 77, fill: rest(5, 3000, { hash: ZERO }) };
    const { read, calls } = reader(() => [rest(5, 3000, { hash: ZERO }), rest(6, 3100, { hash: ZERO })], () => [twapSliceToFill(slice as never)]);
    const fast = new FastMainnetSource(read, G, () => clock);
    clock = 10_000; const result = await fast.read(leader, 1000);
    expect(calls.map(c => c.kind)).toEqual(['fills', 'twap']);
    // tid 6 has no TWAP id anywhere: left out, as the watched source does.
    expect(result!.fills.map(f => [f.tid, f.tradeKey])).toEqual([['5', 'twap:77']]); expect(result!.requestsUsed).toBe(2);
  });

  it('a zero-hash maker fill is an ordinary fill on both paths and in the audit, never a TWAP slice (mainnet 2026-10-18 15:36/15:42: two maker adds were never copied)', async () => {
    // As Hyperliquid answered: hash 0x0…0, twapId null, crossed false (a resting order filled), own cloid; absent from the TWAP endpoint.
    const maker = rest(9, now + 1000, { hash: ZERO, crossed: false, twapId: null, fee: '-0.000259', cloid: `0x${'53'.repeat(16)}` } as Partial<HlUserFill>);
    const { read, calls } = reader(() => [maker]);
    clock = now + 5000;
    const fastRead = await new FastMainnetSource(read, G, () => clock).read(leader, now);
    expect(fastRead!.fills.map(f => f.tid)).toEqual(['9']);
    expect(calls.map(c => c.kind)).toEqual(['fills']); // no TWAP read for it
    await watcherFill(maker); await verified(now - 10_000, now + 2000);
    const watched = await new WatchedMainnetSource(db, () => clock).read(leader, now, now + 2000);
    expect(watched!.fills.map(f => f.tid)).toEqual(['9']);
    // Missed by a stream that covered its time: the audit names it.
    const sources = new CopyLiveSourceRepository(db), uow = new UnitOfWork(db);
    const blind = await new FastMainnetSource(reader(() => []).read, G, () => clock).read(leader, now);
    await uow.run(async tx => sources.apply(tx, (await sources.ensure(tx, leader, 'mainnet')).revision, blind!, clock));
    expect((await new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig()).unmirroredFills(leader)).map(f => f.tid)).toEqual(['9']);
  });

  it('the same tid from both paths is one source fill and no quarantine', async () => {
    // A TWAP slice and an ordinary fill, as the watcher stored them over REST.
    const slice = rest(7, now + 1000, { hash: ZERO, twapId: 77 } as Partial<HlUserFill>), ordinary = rest(8, now + 1100);
    await watcherFill(slice); await watcherFill(ordinary); await verified(now - 10_000, now + 2000);
    clock = now + 5000;
    const sources = new CopyLiveSourceRepository(db), uow = new UnitOfWork(db);
    const watched = await new WatchedMainnetSource(db, () => clock).read(leader, now, now + 2000);
    const first = await uow.run(async tx => sources.apply(tx, (await sources.ensure(tx, leader, 'mainnet')).revision, watched!, clock));
    expect(first.kind).toBe('recorded');
    // The fast path reads the same tids (ordinary endpoint + TWAP endpoint).
    const { read } = reader(() => [{ ...slice, twapId: undefined } as HlUserFill, ordinary], () => [twapSliceToFill({ twapId: 77, fill: { ...slice, twapId: undefined } } as never)]);
    const fastRead = await new FastMainnetSource(read, G, () => clock).read(leader, now);
    expect(fastRead!.fills.map(f => f.tid)).toEqual(['7', '8']);
    // A stale writer still meets the stored evidence: no duplicate conflict.
    const second = await uow.run(async tx => sources.apply(tx, first.stream.revision - 1, fastRead!, clock));
    expect(second.kind).toBe('stale');
    expect(await stream()).toMatchObject({ state: 'ready', lastIssue: null });
    expect(await db.select().from(schema.copyLiveSourceFills)).toHaveLength(2);
  });

  it.each([
    { state: 'filled' as const, freshCoin: 'BTC', first: 'fresh' },
    { state: 'unknown' as const, freshCoin: 'ETH', first: 'fresh' },
    { state: 'unknown' as const, freshCoin: 'BTC', first: 'old-1' },
  ])('prioritizes $first with 100 older $state executions and fresh $freshCoin work', async ({ state, freshCoin, first }) => {
    const repository = new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig());
    await db.insert(schema.copyLiveSourceStreams).values({ id: `mainnet:${leader}`, network: 'mainnet', leaderAddress: leader });
    const fill = async (tid: number, time: number, coin = 'BTC') => {
      const raw = rest(tid, time, { coin }), id = `mainnet:${leader}:${tid}`;
      await db.insert(schema.copyLiveSourceFills).values({ id, streamId: `mainnet:${leader}`, network: 'mainnet', leaderAddress: leader, tid: String(tid), providerTime: new Date(time),
        receivedAt: new Date(time), coin, oid: String(raw.oid), tradeKey: `oid:${raw.oid}`, px: '100', sz: '1', side: 'B', startPosition: '0', normalized: {}, raw: {}, sourceDigest: 'a'.repeat(64) });
      return id;
    };
    const base = { mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', coin: 'BTC', leg: 'open' as const };
    for (let i = 1; i <= 100; i++) {
      const id = await fill(i, now - 100_000 + i), key = `testnet:${seed.f.identity.accountAddress}:0x${i.toString(16).padStart(32, '0')}`;
      await db.insert(schema.copyLiveExecutions).values({ key, network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: `0x${'33'.repeat(20)}`,
        cloid: key.split(':').at(-1)!, nonce: i, userId: 1, strategyId: 9, state, record: { key }, updatedAt: new Date(now) });
      await db.insert(schema.copyLiveDispatches).values({ ...base, id: `old-${i}`, sourceFillId: id, state: 'submitted', executionKey: key, leaderTime: new Date(now - 100_000 + i), receivedAt: new Date(now) });
    }
    await db.insert(schema.copyLiveDispatches).values({ ...base, coin: freshCoin, id: 'fresh', sourceFillId: await fill(500, now, freshCoin), leaderTime: new Date(now), receivedAt: new Date(now) });
    const open = await repository.open();
    expect(open).toHaveLength(100); expect(open[0]!.id).toBe(first);
    expect(open.some(row => row.id === 'fresh')).toBe(first === 'fresh');
    expect((await repository.open(100, ['other'])).length).toBe(0);
  });

  it('an audit miss puts the stream into gap and stores the missed fill', async () => {
    await credit(); clock = now; await engine().tick();
    const missed = rest(9, now + 1500);
    // The fast source certified through now + 3000 without tid 9 (REST had not indexed it).
    const { read } = reader(() => []), fast = new FastMainnetSource(read, G, () => clock);
    clock = now + 5000; await engine(fast).kick(leader);
    expect(await stream()).toMatchObject({ state: 'ready' }); expect((await stream()).coverageThrough!.getTime()).toBe(now + 3000);
    // The watcher's catch-up then confirmed tid 9 inside that span.
    await watcherFill(missed); await verified(now - 10_000, now + 4000);
    const tids = await engine(fast).audit(leader);
    expect(tids).toEqual(['9']);
    expect(await stream()).toMatchObject({ state: 'gap', lastIssue: 'incomplete_coverage' });
    expect((await stream()).coverageThrough!.getTime()).toBe(now + 3000);
    expect((await db.select().from(schema.copyLiveSourceFills)).map(f => f.tid)).toEqual(['9']);
    // A clean audit finds nothing.
    expect(await engine(fast).audit(leader)).toEqual([]);
    // The gap ends with the next complete read: the copy goes on.
    clock = now + 8000; await engine(fast).kick(leader);
    expect(await stream()).toMatchObject({ state: 'ready', lastIssue: null }); expect((await stream()).coverageThrough!.getTime()).toBe(now + 6000);
  });

  describe('a burst of fills in one millisecond (O3)', () => {
    const burst = (count: number, time: number, firstTid = 1) => Array.from({ length: count }, (_, i) => rest(firstTid + i, time));
    const apply = (result: Parameters<CopyLiveSourceRepository['apply']>[2]) => new UnitOfWork(db).run(async tx => {
      const sources = new CopyLiveSourceRepository(db), current = await sources.ensure(tx, leader, 'mainnet');
      return sources.apply(tx, current.revision, result, clock);
    });

    it('600 fast fills at the window start: the window is that millisecond, and coverage moves past it', async () => {
      const fills = [...burst(600, 1000), rest(900, 3000)], { read } = reader(() => fills), fast = new FastMainnetSource(read, G, () => clock);
      clock = 10_000;
      const first = await fast.read(leader, 1000);
      expect(first).toMatchObject({ from: 1000, to: 1000, complete: true }); expect(first!.fills).toHaveLength(600);
      expect(first!.observations).toEqual([expect.objectContaining({ from: 1000, to: 1000, count: 600, saturated: false, sealed: true })]);
      expect((await apply(first!)).stream).toMatchObject({ state: 'ready' });
      expect((await stream()).coverageThrough!.getTime()).toBe(1000);
      const next = await fast.read(leader, 1001);
      expect(next).toMatchObject({ from: 1001, to: 8000, complete: true }); expect(next!.fills.map(f => f.tid)).toEqual(['900']);
      expect((await apply(next!)).stream).toMatchObject({ state: 'ready' }); expect((await stream()).coverageThrough!.getTime()).toBe(8000);
    });

    it('fewer rows before the burst: the window still stops before it, as before', async () => {
      const fills = [...burst(100, 500, 5000), ...burst(600, 1000)], { read } = reader(() => fills), fast = new FastMainnetSource(read, G, () => clock);
      clock = 10_000;
      const first = await fast.read(leader, 400);
      expect(first).toMatchObject({ to: 999, complete: true }); expect(first!.fills).toHaveLength(100);
      expect(first!.observations[0]).not.toHaveProperty('sealed');
    });

    it('a full page in one millisecond cannot be read whole: the stream goes to gap with an alert, not a silent stall', async () => {
      const log = vi.fn(), fills = burst(2500, 1000), page = () => fills.slice(0, 2000);
      const { read } = reader(page), fast = new FastMainnetSource(read, G, () => clock, log);
      clock = 10_000;
      const result = await fast.read(leader, 1000);
      expect(result).toMatchObject({ from: 1000, to: 1000, complete: false, fills: [] });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('ALERT fast source'));
      expect((await apply(result!)).stream).toMatchObject({ state: 'gap', lastIssue: 'incomplete_coverage' });
    });

    it('600 watched fills at the window start: read whole as a window of its own', async () => {
      for (const fill of burst(600, now + 1000)) await watcherFill(fill);
      await watcherFill(rest(900, now + 1500)); await verified(now - 10_000, now + 2000);
      clock = now + 5000;
      const watched = new WatchedMainnetSource(db, () => clock), first = await watched.read(leader, now + 1000, now + 2000);
      expect(first).toMatchObject({ from: now + 1000, to: now + 1000, complete: true }); expect(first!.fills).toHaveLength(600);
      expect(first!.observations[0]).toMatchObject({ count: 600, saturated: false, sealed: true });
      expect((await apply(first!)).stream).toMatchObject({ state: 'ready' });
      const next = await watched.read(leader, now + 1001, now + 2000);
      expect(next!.fills.map(f => f.tid)).toEqual(['900']);
      expect((await apply(next!)).stream).toMatchObject({ state: 'ready' }); expect((await stream()).coverageThrough!.getTime()).toBe(now + 2000);
    });

    it('a sealed window is only one millisecond under the page cap', async () => {
      const fills = burst(600, 1000), { read } = reader(() => fills), fast = new FastMainnetSource(read, G, () => clock);
      clock = 10_000;
      const good = (await fast.read(leader, 1000))!;
      const forged = (change: (observation: Record<string, unknown>) => void) => {
        const { sourceDigest: _digest, ...body } = structuredClone(good);
        change(body.observations[0] as unknown as Record<string, unknown>);
        return { ...body, sourceDigest: liveSourceDigest(body) };
      };
      await expect(apply(forged(o => { delete o.sealed; }))).rejects.toThrow('invalid_live_source_evidence');
      await expect(apply(forged(o => { o.to = 1001; }))).rejects.toThrow('invalid_live_source_evidence');
      await expect(apply(forged(o => { o.count = 2000; }))).rejects.toThrow('invalid_live_source_evidence');
      await expect(apply(forged(o => { o.count = 499; }))).rejects.toThrow('invalid_live_source_evidence');
      await expect(apply(forged(o => { o.sealed = false; }))).rejects.toThrow('invalid_live_source_evidence');
    });
  });

  it('a read that waited for the mainnet budget certifies from when it left, and stays fresh', async () => {
    // The mainnet budget was busy for 6 s (Stage, 2026-10-06: every read went stale and the stream to gap).
    const fills = [rest(1, 1000), rest(2, 9500)], { read } = reader(() => fills, () => [], 6000), fast = new FastMainnetSource(read, G, () => clock);
    clock = 10_000; const result = await fast.read(leader, 500);
    expect(result).toMatchObject({ observedAt: 16_000, to: 14_000, complete: true, fresh: true });
    expect(result!.fills.map(f => f.tid)).toEqual(['1', '2']);
    await new UnitOfWork(db).run(async tx => {
      const sources = new CopyLiveSourceRepository(db), current = await sources.ensure(tx, leader, 'mainnet');
      expect((await sources.apply(tx, current.revision, result!, clock)).stream).toMatchObject({ state: 'ready', lastIssue: null });
    });
  });
});
