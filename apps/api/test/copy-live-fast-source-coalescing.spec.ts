import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import type { CopyLiveEngine } from '../src/copy/live-worker/copy-live-engine.js';
import { CopyLiveWorkerService } from '../src/copy/live-worker/copy-live-worker.service.js';
import { FastMainnetSource, type FastSourceReader } from '../src/copy/live-worker/fast-mainnet-source.js';
import { HyperliquidInfoClient } from '../src/hyperliquid/hyperliquid-info.client.js';
import type { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { sourceLaneOwner } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { testConfig } from './config-test-utils.js';
import { offlineGlobalTransport } from './hyperliquid-quota-test-utils.js';

/**
 * One fast-source read per leader per G window, whatever the trade rate
 * (H-R6, 2026-10-17). Before, a trade witnessed while its leader's read was
 * in flight brought one more read right after it (`resignal`), and a kick
 * due within G of a read was read then: at a high trade rate, one read per
 * witnessed trade, each holding the shared window for a minute (Stage: one
 * active leader held 341 p50 / 580 p95 / 662 max units). The source's
 * `witness` and `followUp` never ask for a read within G of the last, and
 * the worker moves a kick that falls due inside that gap to its end.
 */
const T0 = 1_790_000_000_000, leader = `0x${'44'.repeat(20)}`, G = 2000, FROM = T0 - 10_000;
afterEach(() => { vi.useRealTimers(); });

/** A reader whose fills call takes `latencyMs` and answers nothing (every witnessed trade stays missing). */
function reader(latencyMs: number) {
  const reads: number[] = [];
  const read: FastSourceReader = {
    fills: async () => { reads.push(Date.now()); await new Promise<void>(resolve => setTimeout(resolve, latencyMs)); return { fills: [], sentAt: Date.now() }; },
    twapSlices: async () => [],
  };
  return { read, reads };
}
/** The worker over an engine whose fast source is real; `signal` is the engine's read of the leader's stream. */
function worker(source: FastMainnetSource) {
  const engine = {
    witness: (who: string, tid: number, time: number) => source.witness(who, tid, time),
    followUp: (who: string) => source.followUp(who),
    nextReadAt: (who: string) => source.nextReadAt(who),
    signal: vi.fn(async (who: string) => { await source.read(who, FROM); return { started: Date.now(), read: null, ingest: null, ingestedAt: Date.now(), enqueuedAt: Date.now() }; }),
    workLeader: vi.fn(async () => {}), audit: vi.fn(async () => []), tick: vi.fn(async () => {}), pollTestnetSources: vi.fn(async () => {}),
  };
  const service = new CopyLiveWorkerService(testConfig(), new BackgroundJobs(), engine as unknown as CopyLiveEngine);
  service.start(3_600_000);
  return { service, engine };
}

describe('fast-source kick coalescing: one read per leader per G window', () => {
  it('a burst of trades inside G, before and during the leader\'s read, yields exactly one read; the rest wait for the follow-up G later', async () => {
    vi.useFakeTimers({ now: T0 });
    const { read, reads } = reader(300), source = new FastMainnetSource(read, G, () => Date.now());
    const { service, engine } = worker(source);
    // Five trades G old and younger, all witnessed before the first kick fires: the earliest's due time stands.
    for (let k = 0; k < 5; k++) service.onLeaderTraded({ address: leader, time: T0 - G - 100 + 20 * k, tid: 1 + k });
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toEqual([T0]);
    // Five more while that read is in flight (it left at T0; they are G old at T0+100): no read of their own.
    await vi.advanceTimersByTimeAsync(100);
    for (let k = 0; k < 5; k++) service.onLeaderTraded({ address: leader, time: T0 - G + 20 * k, tid: 10 + k });
    await vi.advanceTimersByTimeAsync(1899); // T0 + 1999
    expect(reads).toEqual([T0]);
    expect(engine.signal).toHaveBeenCalledTimes(1);
    // The follow-up reads them all at once, G after the first read began.
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toEqual([T0, T0 + G]);
    await vi.advanceTimersByTimeAsync(G - 1);
    expect(reads).toEqual([T0, T0 + G]);
    service.onModuleDestroy();
  });

  it('a kick that falls due within G of the leader\'s last read is moved to G after it', async () => {
    vi.useFakeTimers({ now: T0 });
    const { read, reads } = reader(50), source = new FastMainnetSource(read, G, () => Date.now());
    const { service } = worker(source);
    service.onLeaderTraded({ address: leader, time: T0 - G - 100, tid: 1 });
    await vi.advanceTimersByTimeAsync(60); // read at T0, answered at T0+50
    expect(reads).toEqual([T0]);
    // A trade 1.5 s before the read left: certifiable at T0+600, read at T0+G.
    service.onLeaderTraded({ address: leader, time: T0 - 1500, tid: 2 });
    await vi.advanceTimersByTimeAsync(G - 61);
    expect(reads).toEqual([T0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toEqual([T0, T0 + G]);
    service.onModuleDestroy();
  });

  it('the source itself never asks for a read within G of the last one (witness, followUp, nextReadAt)', async () => {
    let clock = 10_000;
    const read: FastSourceReader = { fills: async () => ({ fills: [], sentAt: clock }), twapSlices: async () => [] };
    const source = new FastMainnetSource(read, G, () => clock);
    expect(source.nextReadAt(leader)).toBe(0);
    expect(source.witness(leader, 1, 7000)).toBe(7000 + G + 100);
    await source.read(leader, 5000);
    expect(source.nextReadAt(leader)).toBe(10_000 + G);
    // A trade just before the read left: certifiable at 9600 + G + 100, but read no sooner than G after the read.
    expect(source.witness(leader, 2, 9600)).toBe(10_000 + G);
    expect(source.followUp(leader)).toBeGreaterThanOrEqual(10_000 + G);
    // A trade far enough in the future keeps its own due time.
    expect(source.witness(leader, 3, 12_000)).toBe(12_000 + G + 100);
    // The cap: 60 s / G reads a minute per leader, however many trades the feed reports: 200 trades
    // certifiable before the gap ends are all due at its end.
    clock = 100_000; await source.read(leader, 50_000);
    const dues = new Set<number>();
    for (let k = 0; k < 200; k++) dues.add(source.witness(leader, 100 + k, clock - G - 100 + k)!);
    expect([...dues]).toEqual([clock + G]);
  });
});

describe('the fast source\'s reads go in the shared meter\'s source lane', () => {
  it('under runSource the info client\'s live read charges the `source` lane (no live fallback); outside it, the live lane as before', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json([]));
    const q = offlineGlobalTransport(fetcher), local = { acquire: vi.fn(async () => {}), adjust: vi.fn(), onSuccess: vi.fn(), onRateLimited: vi.fn() };
    const info = new HyperliquidInfoClient(testConfig(), local as unknown as RequestBudgeterService, undefined, q.transport);
    await q.transport.runSource(leader, () => info.userFillsSince(leader, FROM, 'live'));
    // A list's worst case is prepaid on the shared meter (settled to its rows afterwards); the lane is the source's.
    expect(q.acquire).toHaveBeenCalledExactlyOnceWith(120, expect.any(Number), 'source');
    await q.transport.runSource(leader, () => info.userTwapSliceFillsByTime(leader, FROM, undefined, 'live'));
    expect(q.acquire).toHaveBeenLastCalledWith(120, expect.any(Number), 'source');
    await info.userFillsSince(leader, FROM, 'live');
    expect(q.acquire).toHaveBeenLastCalledWith(120, expect.any(Number), undefined, { fallback: 'live' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('a leader\'s source-lane owner is its address\'s hash, never the address', () => {
    expect(sourceLaneOwner(leader)).toMatch(/^[0-9a-f]{8}$/);
    expect(sourceLaneOwner(leader)).toBe(sourceLaneOwner(leader.toUpperCase().replace('0X', '0x')));
    expect(leader.includes(sourceLaneOwner(leader))).toBe(false);
    expect(() => sourceLaneOwner('not-an-address')).toThrow('hyperliquid_quota_invalid');
  });
});
