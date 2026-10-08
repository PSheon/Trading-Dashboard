import { afterEach, describe, expect, it, vi } from 'vitest';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import type { DrizzleDb } from '../src/db/drizzle.provider.js';
import { originalLiveInfoBatch } from '../src/copy/live/live-execution-runtime.js';
import { LiveSharedReads } from '../src/copy/live/live-shared-reads.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';

const bodies = Array.from({ length: 18 }, (_, i) => ({ type: 'userAbstraction', user: `0x${(i + 1).toString(16).padStart(40, '0')}` }));
const permit = () => ({ assertFresh() {}, dispatch: <T>(work: () => T) => work() });
function fixture(raw: typeof fetch, assertFresh = () => undefined) {
  const quota = new PostgresHyperliquidQuota(new UnitOfWork({} as DrizzleDb));
  const acquire = vi.fn(async (_weight: number, _until: number) => permit());
  vi.spyOn(quota, 'bindUnscoped').mockReturnValue({ acquireRest: acquire, reserveSocket: vi.fn() });
  const global = new HyperliquidGlobalTransport(quota, { egressKey: 'test-only', ownerId: 'test-only' }, raw, Date.now);
  const reads = new LiveSharedReads('testnet', global.fetchInfo, originalLiveInfoBatch('testnet', global, assertFresh), Date.now, 5000, async () => undefined);
  return { acquire, reads };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the original runtime adapter bounds actual global batch dispatch', () => {
  it('aborts a sent HTTP sibling within five seconds while preserving the original quota refusal', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    const signals: AbortSignal[] = [];
    const f = fixture(async (_url, init) => {
      if (init?.signal) signals.push(init.signal);
      // Also model a provider that never settles even after cancellation.
      return new Promise<Response>(() => undefined);
    });
    const refusal = new LiveBoundaryError('hyperliquid_quota_exhausted');
    f.acquire.mockImplementation(async weight => { if (weight === 40) throw refusal; return permit(); });
    await f.reads.pay(360);
    let finished = false;
    const outcome = f.reads.wave(bodies).catch(error => { finished = true; return error; });
    await vi.advanceTimersByTimeAsync(5001);
    const finishedByDeadline = finished;
    const canceled = signals.length === 16 && signals.every(signal => signal.aborted);
    expect(finishedByDeadline).toBe(true);
    expect(await outcome).toBe(refusal);
    expect(canceled).toBe(true);
    expect(f.reads.sentWeight).toBe(320);
    expect(f.reads.paidWeight - f.reads.sentWeight).toBe(40);
  });

  it('fences a quota permit that arrives after timeout so refunded weight cannot later dispatch', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let providerCalls = 0;
    const f = fixture(async () => { providerCalls++; return Response.json('disabled'); });
    f.acquire.mockImplementation(async () => { await waiting; return permit(); });
    await f.reads.pay(40);
    let finished = false;
    const outcome = f.reads.wave(bodies.slice(0, 2)).catch(error => { finished = true; return error; });
    await vi.advanceTimersByTimeAsync(5001);
    const finishedBeforePermit = finished;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(finishedBeforePermit).toBe(true);
    expect(await outcome).toBeInstanceOf(LiveBoundaryError);
    expect(providerCalls).toBe(0);
    expect(f.reads.sentWeight).toBe(0);
    expect(f.reads.paidWeight - f.reads.sentWeight).toBe(40);
  });

  it('rechecks original scope freshness at dispatch before spending or native HTTP', async () => {
    let providerCalls = 0;
    const stale = new LiveBoundaryError('live_risk_serialization_stale');
    const f = fixture(async () => { providerCalls++; return Response.json('disabled'); }, () => { throw stale; });
    await f.reads.pay(40);
    await expect(f.reads.wave(bodies.slice(0, 2))).rejects.toBe(stale);
    expect(providerCalls).toBe(0);
    expect(f.reads.sentWeight).toBe(0);
  });

  it('uses only the original epoch time remaining for the final wave', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    let final = false;
    const finalSignals: AbortSignal[] = [];
    const f = fixture(async (_url, init) => {
      if (!final) return Response.json('disabled');
      if (init?.signal) finalSignals.push(init.signal);
      return new Promise<Response>(() => undefined);
    });
    await f.reads.pay(80);
    await f.reads.wave(bodies.slice(0, 2));
    await vi.advanceTimersByTimeAsync(4000);
    final = true;
    let finished = false;
    const outcome = f.reads.unchanged(bodies.slice(0, 2), 'changed').catch(error => { finished = true; return error; });
    await vi.advanceTimersByTimeAsync(1001);
    expect(finished).toBe(true);
    expect(await outcome).toBeInstanceOf(LiveBoundaryError);
    expect(finalSignals).toHaveLength(2);
    expect(finalSignals.every(signal => signal.aborted)).toBe(true);
    expect(f.reads.sentWeight).toBe(80);
  });

  it('keeps successful response bodies readable until the same original deadline', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    const complete: (() => void)[] = [];
    const f = fixture(async (_url, init) => new Response(new ReadableStream({ start(controller) {
      const abort = () => controller.error(init?.signal?.reason);
      init?.signal?.addEventListener('abort', abort, { once: true });
      complete.push(() => {
        init?.signal?.removeEventListener('abort', abort);
        controller.enqueue(new TextEncoder().encode('"disabled"'));
        controller.close();
      });
    } })));
    await f.reads.pay(40);
    await f.reads.wave(bodies.slice(0, 2));
    await vi.advanceTimersByTimeAsync(100);
    complete.forEach(finish => finish());
    expect(await f.reads.get(bodies[0]!)).toBe('disabled');
    expect(await f.reads.get(bodies[1]!)).toBe('disabled');
    expect(f.reads.sentWeight).toBe(40);
  });
});
