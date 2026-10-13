import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../src/config/app-config.js';
import { HyperliquidBudgetWait, LOCAL_HOLD_IDLE_MS, LOCAL_HOLD_READY_MS, liveBudget, localHoldKeys, reserveLive, type LiveBudgetReservation } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { LIVE_HEADROOM_SHARE } from '../src/hyperliquid/wallet-network-hyperliquid.js';

/**
 * A copy setup's step weight from the worker's testnet bucket (gate
 * 2026-10-13 09:48, the 5th run: `local_budget`, weight 613, tokens
 * 524–575). The bucket is wallet-network-hyperliquid's (rate 300, burst 900,
 * 80 % live headroom); other live work spends it as fast as it refills
 * whenever it can. On the release before, a setup's reservation waited its
 * 15 s, gave up its place, and came back to a bucket that other live work had
 * drained again: it never held the weight. Keyed (`holdKey`), it keeps its
 * place in the live queue between passes, the refill builds up for it, and it
 * is whole within the time the refill takes.
 */
afterEach(() => { vi.useRealTimers(); });
const bucket = () => new RequestBudgeterService(new AppConfig({ hyperliquid: { budgetPerMin: 300, burst: 900, startupPaceSeconds: 0, pageReserveShare: 0.25, liveHeadroomShare: LIVE_HEADROOM_SHARE } } as never));
const SETUP = { maxWaitMs: 15_000, queue: true, bucket: 'wallet:testnet' } as const;

describe('a setup\'s keyed reservation on the worker\'s testnet bucket', () => {
  it('gathers its 715 across passes beside live work that drains the bucket, within the refill time', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const budget = bucket();
    try {
      // Other live work has left ~500, and spends 20 every 2 s (600 a minute) whenever the bucket lets it.
      await budget.acquire(400, 'live', 0);
      let stop = false, others = 0;
      const drain = (async () => {
        while (!stop) {
          await reserveLive(budget, 20, { maxWaitMs: 5_000 }).then(() => { others++; }, () => undefined);
          await new Promise(resolve => setTimeout(resolve, 2_000));
        }
      })();
      const setup = liveBudget(budget, SETUP);
      // The setup's driver: a pass every 20 s at most (its waits), each waiting at most 15 s.
      let reservation: LiveBudgetReservation | undefined, waits = 0;
      const started = Date.now();
      while (!reservation && Date.now() - started < 300_000) {
        const pass = setup.reserve!(715, { holdKey: 'setup:a' }).then(r => { reservation = r; }, (error: unknown) => {
          expect(error).toBeInstanceOf(HyperliquidBudgetWait);
          expect((error as HyperliquidBudgetWait).reason).toBe('local_budget');
          expect((error as HyperliquidBudgetWait).retryMs).toBeLessThanOrEqual(15_000);
          waits++;
        });
        await vi.advanceTimersByTimeAsync(15_100);
        await pass;
        if (!reservation) await vi.advanceTimersByTimeAsync(5_000);
      }
      stop = true;
      await vi.advanceTimersByTimeAsync(5_000); await drain;
      expect(reservation).toBeDefined();
      // (715 − ~500) at 5 a second: whole after ~45 s, taken by the third pass.
      expect(Date.now() - started).toBeLessThan(61_000);
      expect(waits).toBeLessThanOrEqual(3);
      expect(others).toBeGreaterThan(0);
      reservation!.release();
    } finally { budget.onModuleDestroy(); }
  });

  it('a parked reservation is the key\'s next pass\'s; one nobody comes back for is given back', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const budget = bucket();
    try {
      const setup = liveBudget(budget, SETUP);
      const first = await setup.reserve!(715, { holdKey: 'setup:b' });
      const left = budget.introspect().tokensAvailable;
      // The shared claim waits: parked, not refunded; the next pass takes it at once.
      first.park!();
      expect(localHoldKeys(budget)).toEqual(['setup:b']);
      expect(budget.introspect().tokensAvailable).toBeCloseTo(left, 0);
      const again = await setup.reserve!(715, { holdKey: 'setup:b' });
      expect(localHoldKeys(budget)).toEqual([]);
      // Parked and never taken: given back after LOCAL_HOLD_READY_MS.
      again.park!();
      await vi.advanceTimersByTimeAsync(LOCAL_HOLD_READY_MS + 1);
      expect(localHoldKeys(budget)).toEqual([]);
      expect(budget.introspect().tokensAvailable).toBeGreaterThan(left + 700);
    } finally { budget.onModuleDestroy(); }
  });

  it('a hold still gathering that nobody asks for again leaves the queue: later live work is not held behind it', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const budget = bucket();
    try {
      await budget.acquire(800, 'live', 0);
      const setup = liveBudget(budget, SETUP);
      const pass = setup.reserve!(715, { holdKey: 'setup:c', maxWaitMs: 1_000 }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(await pass).toBeInstanceOf(HyperliquidBudgetWait);
      expect(localHoldKeys(budget)).toEqual(['setup:c']);
      expect(budget.queued().live).toBe(1);
      await vi.advanceTimersByTimeAsync(LOCAL_HOLD_IDLE_MS + 1);
      expect(localHoldKeys(budget)).toEqual([]);
      expect(budget.queued().live).toBe(0);
    } finally { budget.onModuleDestroy(); }
  });
});
