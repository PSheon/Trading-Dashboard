import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@trading-dashboard/shared/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { sharedRestRetryAfterMs } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { sharedCapacityWait } from '../src/hyperliquid/hyperliquid-budget-wait.js';
// @ts-expect-error -- the harness's plain ESM helper (no declarations)
import { installDbRtt } from '../../../scripts/copy-harness/db-rtt.mjs';
import { closeTestDb, getTestDb } from './db-test-utils.js';

/**
 * A cold live order while a setup's account-mode attempt runs, on the real
 * Postgres meter, with contention.mjs's background loops and the
 * stage-like 8 ms per statement. The order's evidence (589: its first wave,
 * the other coins, the final check, the POST, ~1 s apart) has 5 s and real
 * money; the setup can wait.
 *
 * Before: the order's waves were unlabelled; between them the setup's
 * attempt (493) went on up to the 960 below the live reserve, and the
 * order's final check was refused (a 65 s window).
 */
const RTT_MS = 8, ATTEMPT = [102, 42, 102, 102, 42, 102, 1], ORDER = [250, 89, 249, 1], SETUP_BOUND_MS = 100_000;
let db: ReturnType<typeof getTestDb>;
beforeAll(() => { db = getTestDb(); });
afterAll(async () => { await closeTestDb(); });

describe('a cold live order beside a setup on the shared Postgres meter', () => {
  it('gets its full weight within 5 s and is never refused; the setup still completes in bounded time', { timeout: SETUP_BOUND_MS + 60_000 }, async () => {
    const restore = installDbRtt(pg.Client, RTT_MS);
    const egressKey = `live-lane-${randomUUID()}`, pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 16 });
    const uow = () => new UnitOfWork(drizzle(pool, { schema }));
    const transport = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(uow()), { egressKey, ownerId: 'worker' }, async () => Response.json({}));
    const capacity = transport as unknown as { claimLive?(weight: number, giveUpAt: number): Promise<string | undefined>; runLive?<T>(token: string, work: () => Promise<T>): Promise<T> };
    const stop = new AbortController();
    try {
      // Background at the cap a granted setup claim leaves it (240), charged over the last few seconds.
      const now = Date.now();
      const events = Array.from({ length: 12 }, (_, i) => ({ id: `seed-${i}`, kind: 'rest' as const, units: 20, reservedAt: now - 5_000 + i * 300, expiresAt: now + 60_000 + i * 300 }));
      await db.insert(schema.hyperliquidEgressQuota).values({ egressKey, events, updatedAt: new Date(now - 1) });

      // contention.mjs's loops, from the setup's first claim on (before it,
      // background takes its whole cap at once: the setup would wait a window first).
      let claimedOnce!: () => void;
      const claimed = new Promise<void>(resolve => { claimedOnce = resolve; });
      const contention = new PostgresHyperliquidQuota(uow()), counts = { granted: 0, refused: 0, errors: 0 };
      const loops = Array.from({ length: 8 }, async (_, n) => {
        const bound = contention.bindUnscoped({ egressKey, ownerId: `harness-background-${n}` });
        await claimed;
        while (!stop.signal.aborted) {
          try { (await bound.acquireRest(20, Date.now() + 5000, 'background')).dispatch(() => undefined); counts.granted++; await wait(50); }
          catch (error) { const retry = sharedRestRetryAfterMs(error); if (retry === undefined) counts.errors++; else counts.refused++; await wait(Math.min(retry ?? 1000, 250 + Math.random() * 250)); }
        }
      });

      // The setup's mode step: claim, then its attempt's charges ~100 ms apart;
      // a refusal partway is waited out as the setup service waits it, then claimed again.
      const trace: string[] = [];
      let firstCharge!: () => void;
      const charged = new Promise<void>(resolve => { firstCharge = resolve; });
      const setup = (async () => {
        const started = Date.now(), key = randomUUID();
        let attempts = 0;
        while (Date.now() - started < SETUP_BOUND_MS) {
          attempts++;
          let waitMs: number;
          // As the setup service: a claim the full window can't record yet is a wait too.
          try { waitMs = await transport.claimSetup(ATTEMPT.reduce((a, b) => a + b, 0) + 120, key); }
          catch (error) { const retry = sharedCapacityWait(error); if (!retry) throw error; waitMs = retry.retryMs; }
          trace.push(`${Date.now() - started} claim ${waitMs}`); claimedOnce();
          if (waitMs > 0) { await wait(Math.min(waitMs + 250, 20_000)); continue; }
          try {
            await transport.runSetup(async () => {
              for (const weight of ATTEMPT) { (await transport.currentQuota().acquireRest(weight, Date.now() + 5000)).dispatch(() => undefined); firstCharge(); await wait(100); }
            }, key);
            return { ms: Date.now() - started, attempts };
          } catch (error) {
            const retry = sharedCapacityWait(error);
            trace.push(`${Date.now() - started} refused ${retry?.retryMs} ${String(error)}`);
            if (!retry) throw error;
            await wait(Math.min(retry.retryMs, 20_000));
          }
        }
        return { ms: Infinity, attempts };
      })();

      // The cold order arrives as the setup's attempt starts.
      await charged;
      const orderStarted = Date.now(), refused: unknown[] = [];
      const token = capacity.claimLive ? await capacity.claimLive(ORDER.reduce((a, b) => a + b, 0), orderStarted + 5_000) : undefined;
      const claimedAt = Date.now();
      const send = async () => {
        for (const weight of ORDER) {
          // As originalLiveInfoBatch sends a wave: no wait for room (maxWaitMs 0).
          try { (await transport.currentQuota().acquireRest(weight, Date.now() + 5000)).dispatch(() => undefined); }
          catch (error) { refused.push(error); }
          await wait(1_000);
        }
      };
      await (token !== undefined && capacity.runLive ? capacity.runLive(token, send) : send());
      const orderMs = Date.now() - orderStarted;
      const readHeld = async () => {
        const [row] = await db.select().from(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey));
        const at = Date.now();return row!.events.filter(e => e.kind === 'rest' && e.expiresAt > at);
      };
      const afterOrder = await readHeld();
      const result = await setup;
      stop.abort(); await Promise.all(loops);

      const held = await readHeld();
      console.log(JSON.stringify({ orderMs, claimMs: claimedAt - orderStarted, refused: refused.length, setup: result, trace, counts,
        afterOrder: afterOrder.reduce<Record<string, number>>((m, e) => { const k = /^[a-z-]+:/.test(e.id) ? e.id.split(':')[0]! : 'unlabelled'; m[k] = (m[k] ?? 0) + e.units; return m; }, {}) }));

      // The order: never refused, all its weight within its 5 s.
      expect(refused).toEqual([]);
      expect(orderMs).toBeLessThan(5_000);
      // Its charges are the live lane's, under its demand.
      expect(afterOrder.filter(e => e.id.startsWith(`live:${token}:`)).map(e => e.units).sort((a, b) => a - b)).toEqual([...ORDER].sort((a, b) => a - b));
      expect(afterOrder.some(e => e.id.startsWith('live-demand:'))).toBe(true);
      expect(afterOrder.reduce((sum, e) => sum + e.units, 0)).toBeLessThanOrEqual(1200);
      // The setup still completes, in bounded time; background was refused.
      expect(result.ms).toBeLessThan(SETUP_BOUND_MS);
      expect(counts.errors).toBe(0);
      expect(counts.refused).toBeGreaterThan(0);
      expect(held.reduce((sum, e) => sum + e.units, 0)).toBeLessThanOrEqual(1200);
    } finally {
      stop.abort();
      restore();
      await db.delete(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey));
      await pool.end();
    }
  });
});
