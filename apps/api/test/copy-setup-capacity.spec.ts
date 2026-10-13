import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sharedRestRetryAfterMs } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { Meter, T0, Testnet, database, setupIntent, sleep, worker } from './copy-setup-capacity-test-utils.js';

/**
 * The pre-mainnet gate of 2026-10-13 (`copy_setup_running FAIL funded
 * (hyperliquid_busy) after 602 s`), simulated on the real planner with an
 * in-memory meter row and simulated time (copy-setup-capacity-test-utils.ts).
 * copy-setup-contention-postgres.spec.ts runs the same setup on the real
 * Postgres meter, in real time, beside contention.mjs's loops.
 */
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a copy setup beside a full background lane (2026-10-13 gate)', () => {
  it('gets funded → mode_set → agent_active → running within a bounded time; live orders keep going; background is refused first', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms); return c.signal; });
    const setupId = randomUUID(), intent = setupIntent(setupId);
    const meter = new Meter(), testnet = new Testnet(), db = database(intent, setupId), signed: string[] = [];
    const { service, quota } = worker(meter, testnet, db, signed);

    // contention.mjs: eight loops keep the background lane full.
    let stop = false;
    const background = { granted: 0, refused: 0, errors: 0, grantedWhileSetup: 0, refusedWhileSetup: 0 };
    let setupRunning = false, jitter = 0;
    const loops = Array.from({ length: 8 }, async (_, n) => {
      const lane = meter.quota().bindUnscoped({ egressKey: 'gate:testnet', ownerId: `harness-background-${n}` });
      while (!stop) {
        try { await lane.acquireRest(20, Date.now() + 5000, 'background'); background.granted++; if (setupRunning) background.grantedWhileSetup++; await sleep(50); }
        catch (error) {
          const retry = sharedRestRetryAfterMs(error);
          if (retry === undefined) background.errors++; else { background.refused++; if (setupRunning) background.refusedWhileSetup++; }
          jitter = (jitter + 97) % 250; await sleep(Math.min(retry ?? 1000, 250 + jitter));
        }
      }
    });
    // A live copy's orders: an order's unlabelled charges (its boundary
    // read, account snapshot and the POST) every 10 s.
    const liveOrders = { sent: 0, refused: 0 };
    const orders = (async () => {
      const bound = quota.bindUnscoped({ egressKey: 'gate:testnet', ownerId: 'live' });
      while (!stop) {
        await sleep(10_000);
        for (const weight of [21, 22, 1]) {
          try { (await bound.acquireRest(weight, Date.now() + 5000)).dispatch(() => undefined); liveOrders.sent++; } catch { liveOrders.refused++; }
        }
      }
    })();
    // A minute of background first: its 840 spread over the window, as on Stage.
    await vi.advanceTimersByTimeAsync(70_000);
    expect(meter.restHeld()).toBeGreaterThanOrEqual(820);
    expect(background.refused).toBeGreaterThan(0);

    const warn = vi.spyOn(Logger.prototype, 'warn');
    const started = Date.now();
    setupRunning = true;
    let ticking = false, nextTick = started;
    const errors: string[] = [];
    const deadline = started + 10 * 60_000;
    while (Date.now() < deadline && db.rows.setup.stage !== 'running') {
      if (Date.now() >= nextTick && !ticking) {
        nextTick = Date.now() + 3_000; ticking = true;
        void service.tick().catch(error => { errors.push(String(error?.message ?? error)); }).finally(() => { ticking = false; });
      }
      await vi.advanceTimersByTimeAsync(100);
    }
    setupRunning = false;
    const elapsed = Date.now() - started;
    // Background has its cap again once no setup waits.
    const grantedBefore = background.granted;
    await vi.advanceTimersByTimeAsync(130_000);
    stop = true;
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all([...loops, orders]);

    expect(db.rows.stages.map(s => s.stage)).toEqual(['mode_set', 'agent_active', 'builder_ready', 'running']);
    // Bounded: the background ahead of it drains within a charge's 65 s,
    // once; never a 65 s window per try (before: never, after 600 s).
    expect(elapsed).toBeLessThan(180_000);
    expect(testnet.posts).toBe(1);
    expect(signed).toEqual(['HyperliquidTransaction:UserSetAbstraction', 'HyperliquidTransaction:ApproveAgent']);
    expect(errors).toEqual([]);
    // Every wait the setup had was the meter's own estimate, never a blind 65 s.
    for (const wait of db.rows.waits as { reason: string; retryMs: number }[]) if (wait.reason === 'shared_capacity') expect(wait.retryMs).toBeLessThan(65_000);
    // Live orders all went out while the setup ran beside a full background lane.
    expect(liveOrders.refused).toBe(0);
    expect(liveOrders.sent).toBeGreaterThan(30);
    // Background was refused first, and has its share again afterwards.
    expect(background.errors).toBe(0);
    expect(background.refusedWhileSetup).toBeGreaterThan(100);
    expect(background.grantedWhileSetup).toBeLessThan(background.refusedWhileSetup / 50);
    expect(background.granted - grantedBefore).toBeGreaterThan(20);
    // Never over the provider's per-IP 1200.
    expect(meter.peak).toBeLessThanOrEqual(1200);
    // Each claim that waited logged its need and what the meter held then, by class.
    const claimWaits = warn.mock.calls.map(c => String(c[0])).filter(m => m.includes(' claim waits '))
      .map(m => JSON.parse(m.slice(m.indexOf('{'))) as { need: number; waitMs: number; meter: { total: number; background: number; pending: { need: number }[] } });
    expect(claimWaits.length).toBeGreaterThan(0);
    expect(claimWaits[0]!.meter.background).toBeGreaterThan(0);
    expect(claimWaits[0]!.meter.pending.map(p => p.need)).toContain(claimWaits[0]!.need);
  }, 120_000);
});
