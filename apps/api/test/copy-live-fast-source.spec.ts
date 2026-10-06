import * as schema from '@trading-dashboard/shared/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { digest as mandateDigest } from '../src/copy/copy-live-mandate-evidence.js';
import { CopyLiveSourceRepository } from '../src/copy/copy-live-source.repository.js';
import { liveSourceExecutionCloid } from '../src/copy/live/postgres-live-preparation.js';
import type { LiveExecutionRecord } from '../src/copy/live/live-execution.js';
import type { TestnetLiveExecutionHooks, TestnetLiveExecutionRequest } from '../src/copy/live/testnet-live-execution-runtime.js';
import { CopyLiveEngine, type LiveEngineDependencies } from '../src/copy/live-worker/copy-live-engine.js';
import { CopyLiveWorkerRepository } from '../src/copy/live-worker/copy-live-worker.repository.js';
import { WatchedMainnetSource } from '../src/copy/live-worker/watched-mainnet-source.js';
import { FastMainnetSource, type FastSourceReader } from '../src/copy/live-worker/fast-mainnet-source.js';
import { twapSliceToFill } from '../src/hyperliquid/hyperliquid-info.client.js';
import type { HlUserFill } from '../src/hyperliquid/types.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { now } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

// Real SQL, sources and repositories; the exchange runtime and settler are
// doubles, the provider is a fake `userFillsByTime` / TWAP reader.
let db: TestDb, clock: number, seed: Awaited<ReturnType<typeof preparationFixture>>;
const leader = `0x${'44'.repeat(20)}`, G = 2000, ZERO = `0x${'00'.repeat(32)}`;
const runtimeCalls: TestnetLiveExecutionRequest[] = [];
const keyOf = (fillId: string, leg: 'open' | 'close') => `testnet:${seed.f.identity.accountAddress}:${liveSourceExecutionCloid('mandate', fillId, leg)}`;
const filled = async (request: TestnetLiveExecutionRequest, hooks: Pick<TestnetLiveExecutionHooks, 'onExchange'>) => {
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
function reader(fills: () => HlUserFill[], slices: () => HlUserFill[] = () => []) {
  const calls: { kind: 'fills' | 'twap'; from: number }[] = [];
  const read: FastSourceReader = {
    fills: async (_leader, from) => { calls.push({ kind: 'fills', from }); return fills().filter(f => f.time >= from && f.time <= clock); },
    twapSlices: async (_leader, from) => { calls.push({ kind: 'twap', from }); return slices().filter(f => f.time >= from && f.time <= clock); },
  };
  return { read, calls };
}
function engine(fast?: FastMainnetSource, extra: Partial<LiveEngineDependencies> = {}) {
  return new CopyLiveEngine({
    repository: new CopyLiveWorkerRepository(db, new UnitOfWork(db)), sources: new CopyLiveSourceRepository(db), uow: new UnitOfWork(db),
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

  it('runs fresh pending legs ahead of 100 older submitted ones', async () => {
    const repository = new CopyLiveWorkerRepository(db, new UnitOfWork(db));
    await db.insert(schema.copyLiveSourceStreams).values({ id: `mainnet:${leader}`, network: 'mainnet', leaderAddress: leader });
    const fill = async (tid: number, time: number) => {
      const raw = rest(tid, time), id = `mainnet:${leader}:${tid}`;
      await db.insert(schema.copyLiveSourceFills).values({ id, streamId: `mainnet:${leader}`, network: 'mainnet', leaderAddress: leader, tid: String(tid), providerTime: new Date(time),
        receivedAt: new Date(time), coin: 'BTC', oid: String(raw.oid), tradeKey: `oid:${raw.oid}`, px: '100', sz: '1', side: 'B', startPosition: '0', normalized: {}, raw: {}, sourceDigest: 'a'.repeat(64) });
      return id;
    };
    const base = { mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', coin: 'BTC', leg: 'open' as const };
    for (let i = 1; i <= 100; i++) {
      const id = await fill(i, now - 100_000 + i), key = `testnet:${seed.f.identity.accountAddress}:0x${i.toString(16).padStart(32, '0')}`;
      await db.insert(schema.copyLiveExecutions).values({ key, network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: `0x${'33'.repeat(20)}`,
        cloid: key.split(':').at(-1)!, nonce: i, userId: 1, strategyId: 9, state: 'unknown', record: { key }, updatedAt: new Date(now) });
      await db.insert(schema.copyLiveDispatches).values({ ...base, id: `old-${i}`, sourceFillId: id, state: 'submitted', executionKey: key, leaderTime: new Date(now - 100_000 + i), receivedAt: new Date(now) });
    }
    await db.insert(schema.copyLiveDispatches).values({ ...base, id: 'fresh', sourceFillId: await fill(500, now), leaderTime: new Date(now), receivedAt: new Date(now) });
    const open = await repository.open();
    expect(open).toHaveLength(100); expect(open[0]!.id).toBe('fresh');
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
  });
});
