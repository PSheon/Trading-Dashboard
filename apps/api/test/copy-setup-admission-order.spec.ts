import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../src/config/app-config.js';
import { HyperliquidBudgetWait } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { LIVE_HEADROOM_SHARE } from '../src/hyperliquid/wallet-network-hyperliquid.js';
import { Meter, T0, Testnet, database, setupIntent, worker } from './copy-setup-capacity-test-utils.js';

/**
 * A setup step's admission comes before its first read, local first (gate
 * 2026-10-13 09:48, the 5th run). On the release before, the shared claim was
 * granted first and the step's 613 was reserved from the worker's bucket only
 * inside it: the grant's hold ran while the bucket refused, and a wait inside
 * the step past 20 s was logged as the shared meter's (`shared_capacity`,
 * `shared:setup`) with the local bucket's lane, tokens and queue.
 */
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const SETUP = { maxWaitMs: 15_000, queue: true, bucket: 'wallet:testnet' } as const;

describe('a setup step\'s admission order', () => {
  it('waits on its local bucket before it claims the shared meter: only its place in the queue, no grant, no hold, nothing charged while the bucket is short', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms); return c.signal; });
    const budget = new RequestBudgeterService(new AppConfig({ hyperliquid: { budgetPerMin: 300, burst: 900, startupPaceSeconds: 0, pageReserveShare: 0.25, liveHeadroomShare: LIVE_HEADROOM_SHARE } } as never));
    try {
      await budget.acquire(600, 'live', 0);
      const setupId = randomUUID(), meter = new Meter(), db = database(setupIntent(setupId), setupId), signed: string[] = [];
      const { service } = worker(meter, new Testnet(), db, signed, 'gate:testnet', { budget, reserve: SETUP, sockets: false });
      let done = false;
      void service.tick().finally(() => { done = true; });
      for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(100);
      expect(done).toBe(true);
      // The bucket held ~300 of 715: a local wait, with the bucket's own detail…
      expect(db.rows.waits).toHaveLength(1);
      expect(db.rows.waits[0]).toMatchObject({ reason: 'local_budget', bucket: 'wallet:testnet', lane: 'live', weight: 715 });
      // …and on the shared meter only its place in the queue (a 1-unit marker, not granted): no hold, no charge.
      const alive = meter.state.events.filter(e => e.expiresAt > Date.now());
      expect(alive.map(e => [e.id.split(':').slice(0, 2).join(':'), e.units, e.id.endsWith(':g')])).toEqual([['setup-demand:635', 1, false]]);
      expect(alive[0]!.id).toMatch(/:c2$/);
    } finally { budget.onModuleDestroy(); }
  }, 60_000);

  it('a local wait inside a granted step keeps its own reason and bucket, and the step gives back its grant only once it ends', async () => {
    const setupId = randomUUID(), db = database(setupIntent(setupId), setupId), signed: string[] = [];
    const { service } = worker(new Meter(), new Testnet(), db, signed);
    const capacity = { claimSetup: vi.fn(async () => 0), runSetup: vi.fn(async () => { throw new HyperliquidBudgetWait(30_000, 'local_budget', { weight: 102, lane: 'live', bucket: 'wallet:testnet', tokens: 498, queued: 2 }); }),
      releaseSetup: vi.fn(async () => undefined) };
    // The steps part holds the shared meter's seam since the service was split (copy-live-setup-steps.ts).
    (service as unknown as { steps: { capacity: unknown } }).steps.capacity = capacity;
    await service.tick();
    expect(capacity.claimSetup).toHaveBeenCalledTimes(1);
    expect(db.rows.waits[0]).toMatchObject({ reason: 'local_budget', retryMs: 20_000, bucket: 'wallet:testnet', lane: 'live', tokens: 498, queued: 2 });
    // A wait keeps the grant for its next pass (whose claim continues it).
    expect(capacity.releaseSetup).not.toHaveBeenCalled();
    // A step that ends (here: it fails) gives it back.
    capacity.runSetup.mockImplementationOnce(async () => { throw new Error('boom'); });
    db.rows.setup = { ...db.rows.setup, nextAttemptAt: null };
    await service.tick();
    expect(capacity.releaseSetup).toHaveBeenCalledWith(setupId);
  });

  it('claims the step\'s socket connects with its weight', async () => {
    const setupId = randomUUID(), db = database(setupIntent(setupId), setupId), signed: string[] = [];
    const { service } = worker(new Meter(), new Testnet(), db, signed);
    const capacity = { claimSetup: vi.fn(async () => 5_000), runSetup: vi.fn(), releaseSetup: vi.fn(async () => undefined) };
    // The steps part holds the shared meter's seam since the service was split (copy-live-setup-steps.ts).
    (service as unknown as { steps: { capacity: unknown } }).steps.capacity = capacity;
    await service.tick();
    expect(capacity.claimSetup).toHaveBeenCalledWith(635, setupId, expect.any(Function), 2);
    expect(capacity.runSetup).not.toHaveBeenCalled();
  });
});
