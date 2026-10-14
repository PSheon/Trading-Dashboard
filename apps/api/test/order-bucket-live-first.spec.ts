import { afterEach, expect, it, vi } from 'vitest';
import { AppConfig } from '../src/config/app-config.js';
import { reserveLive } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { LIVE_HEADROOM_SHARE } from '../src/config/constants/hyperliquid.js';

/**
 * The wallet network's order bucket (wallet-network-hyperliquid: rate 300,
 * burst 900, 80 % live headroom) has no starvation guard: a live order's
 * evidence never waits for a background call's forced turn. In the 7th
 * gate's model (copy-live-starvation-postgres.spec.ts, 2026-10-13) the order's
 * 568 waited ~24 s beside a bucket holding 860: the leader's source reads
 * had made three live dispatches in a row while the follower monitor's
 * receipts (240, background) waited for the main bucket, and the forced
 * background turn held every live call heavier than the reserve alone.
 */
afterEach(() => { vi.useRealTimers(); });

it("a live order's evidence goes at once while the bucket holds it, whatever background call is owed a turn", async () => {
  vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const budget = new RequestBudgeterService(new AppConfig({ hyperliquid: { budgetPerMin: 300, burst: 900, startupPaceSeconds: 0, pageReserveShare: 0.25, liveHeadroomShare: LIVE_HEADROOM_SHARE } } as never));
  try {
    // Snapshots took some of the main bucket (180 → 80); the receipts' 240 waits for it to refill.
    await budget.acquire(100, 'background');
    let receipts = false;
    void budget.acquire(240, 'background').then(() => { receipts = true; }, () => undefined);
    // Three live dispatches in a row while it waits (the source's reads): the reserve 720 → 570.
    for (let i = 0; i < 3; i++) await reserveLive(budget, 50, { maxWaitMs: 5_000 });
    expect(receipts).toBe(false);
    // The order's evidence (600): the bucket holds 650 of it now.
    let paid = false;
    void reserveLive(budget, 600, { maxWaitMs: 120_000 }).then(() => { paid = true; }, () => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(paid).toBe(true);
    // Background still gets what live leaves (once the live reserve has refilled: 600 at 5 a second).
    await vi.advanceTimersByTimeAsync(200_000);
    expect(receipts).toBe(true);
  } finally { budget.onModuleDestroy(); }
});

it("a live reservation's unused weight goes back to the bucket even when its main part is full: a source read costs what it read, not its prepaid 240", async () => {
  const budget = new RequestBudgeterService(new AppConfig({ hyperliquid: { budgetPerMin: 300, burst: 900, startupPaceSeconds: 0, pageReserveShare: 0.25, liveHeadroomShare: LIVE_HEADROOM_SHARE } } as never));
  try {
    // The leader's fills and TWAP lists, 120 each prepaid (from the reserve), each answered empty (20).
    await reserveLive(budget, 240, { maxWaitMs: 5_000 });
    budget.adjust(-200);
    expect(budget.introspect().tokensAvailable).toBeCloseTo(860, 0);
    // Twice more: the order's evidence (568) still fits at once (before: 900 − 3 × 240 = 180).
    for (let i = 0; i < 2; i++) { await reserveLive(budget, 240, { maxWaitMs: 5_000 }); budget.adjust(-200); }
    expect(budget.liveWaitMs(568)).toBe(0);
  } finally { budget.onModuleDestroy(); }
});
