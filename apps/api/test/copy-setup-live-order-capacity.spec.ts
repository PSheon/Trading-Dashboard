import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sharedRestRetryAfterMs } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { Meter, T0, Testnet, database, setupIntent, sleep, worker } from './copy-setup-capacity-test-utils.js';

/**
 * Two setups and a cold live order at the same time, under contention.mjs's
 * load, simulated (copy-setup-capacity.spec.ts's gate: the real setup
 * service, clients and planner; the meter's row in memory; simulated time).
 * The order arrives as the setup's account-mode attempt starts: its evidence
 * (an owner with two accounts, cold: 772, in four waves ~1 s apart, each
 * refused at once when the window has no room, as originalLiveInfoBatch
 * sends them) has 5 s and real money.
 *
 * Before: the order's waves were unlabelled and nothing was announced; the
 * setups' attempts went on between them up to the 960 below the live
 * reserve, and the order's later waves were refused.
 */
const ORDER = [400, 150, 221, 1];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('copy setups and a cold live order at the same time, beside a full background lane', () => {
  it('the order gets its whole weight within 5 s and is never refused; the setups still reach running in bounded time', async () => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms); return c.signal; });
    // Two owners' one-click setups at once (each its own worker objects), on one meter.
    const meter = new Meter();
    const setups = [0, 1].map(() => {
      const setupId = randomUUID(), testnet = new Testnet(), db = database(setupIntent(setupId), setupId), signed: string[] = [];
      return { testnet, db, signed, ticking: false, nextTick: 0, ...worker(meter, testnet, db, signed) };
    });
    const { transport } = setups[0]!;
    const live = transport as unknown as { claimLive?(weight: number, giveUpAt: number): Promise<string | undefined>; runLive?<T>(token: string, work: () => Promise<T>): Promise<T> };

    // contention.mjs: eight loops keep the background lane full.
    let stop = false;
    const background = { refused: 0, errors: 0 };
    const loops = Array.from({ length: 8 }, async (_, n) => {
      const lane = meter.quota().bindUnscoped({ egressKey: 'gate:testnet', ownerId: `harness-background-${n}` });
      let jitter = n * 31;
      while (!stop) {
        try { await lane.acquireRest(20, Date.now() + 5000, 'background'); await sleep(50); }
        catch (error) {
          if (sharedRestRetryAfterMs(error) === undefined) background.errors++; else background.refused++;
          jitter = (jitter + 97) % 250; await sleep(Math.min(sharedRestRetryAfterMs(error) ?? 1000, 250 + jitter));
        }
      }
    });
    await vi.advanceTimersByTimeAsync(70_000);

    // The cold order, fired as the setup's mode attempt starts (its first preflight's first charge).
    const order = { fired: false, refused: [] as unknown[], ms: Infinity, token: undefined as string | undefined };
    const fire = async () => {
      const started = Date.now();
      order.token = live.claimLive ? await live.claimLive(ORDER.reduce((a, b) => a + b, 0), started + 5_000) : undefined;
      const send = async () => {
        const bound = transport.currentQuota();
        for (const weight of ORDER) {
          try { (await bound.acquireRest(weight, Date.now() + 5000, undefined, { owner: 'order' })).dispatch(() => undefined); } catch (error) { order.refused.push(error); }
          await sleep(1_000);
        }
      };
      await (order.token !== undefined && live.runLive ? live.runLive(order.token, send) : send());
      order.ms = Date.now() - started;
    };
    let firing: Promise<void> | undefined;

    const started = Date.now(), errors: string[] = [];
    while (Date.now() < started + 10 * 60_000 && setups.some(s => s.db.rows.setup.stage !== 'running')) {
      if (!order.fired && meter.state.events.some(e => e.id.startsWith('setup:'))) { order.fired = true; firing = fire(); }
      for (const setup of setups) {
        if (Date.now() < setup.nextTick || setup.ticking) continue;
        setup.nextTick = Date.now() + 1_000; setup.ticking = true;
        void setup.service.tick().catch(error => { errors.push(String(error?.message ?? error)); }).finally(() => { setup.ticking = false; });
      }
      await vi.advanceTimersByTimeAsync(50);
    }
    const elapsed = Date.now() - started;
    await vi.advanceTimersByTimeAsync(10_000);
    await firing;
    stop = true;
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all(loops);

    expect(order.fired).toBe(true);
    // The order: never refused, its whole weight within its 5 s.
    expect(order.refused).toEqual([]);
    expect(order.ms).toBeLessThan(5_000);
    // The setup: refused partway (the order came first), then running, bounded.
    expect(errors).toEqual([]);
    expect(elapsed).toBeLessThan(300_000);
    for (const { db, testnet, signed } of setups) {
      expect(db.rows.stages.map(s => s.stage)).toEqual(['mode_set', 'agent_active', 'builder_ready', 'running']);
      // One mode POST: an attempt the order made yield before its POST is signed again, never sent twice.
      expect(testnet.posts).toBe(1);
      expect(new Set(signed)).toEqual(new Set(['HyperliquidTransaction:UserSetAbstraction', 'HyperliquidTransaction:ApproveAgent']));
    }
    expect(background.errors).toBe(0);
    expect(background.refused).toBeGreaterThan(100);
    expect(meter.peak).toBeLessThanOrEqual(1200);
  }, 120_000);
});
