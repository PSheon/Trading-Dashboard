import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@trading-dashboard/shared/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { sharedRestRetryAfterMs } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { sharedCapacityWait } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { closeTestDb, getTestDb } from './db-test-utils.js';

/**
 * The 2026-10-13 gate on the real Postgres meter: a copy setup's steps beside
 * the background lane kept full as contention.mjs keeps it (eight loops
 * asking 20 each, a refusal retried after 250–500 ms) and a live copy's
 * orders. The background ahead of the setup is a minute's 840, its charges
 * expiring within 12 s (seeded, so the test needn't wait out 65 s windows).
 *
 * Before the fix the setup's charges were unlabelled: the 360 background left
 * minus the live orders' could not hold an attempt (~500 in its minute), a
 * refused charge failed the attempt, and its retry waited a fixed 65 s.
 */
const ATTEMPT = [102, 42, 102, 102, 42, 102, 1], AGENT = [80, 1];
const DEADLINE_MS = 40_000;
let db: ReturnType<typeof getTestDb>;
beforeAll(() => { db = getTestDb(); });
afterAll(async () => { await closeTestDb(); });

describe('a copy setup on the shared Postgres meter beside a full background lane', () => {
  it('gets its steps\' weight within a bounded time, ahead of background, while live orders keep going', { timeout: 90_000 }, async () => {
    const egressKey = `setup-lane-${randomUUID()}`, pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 16 });
    const quota = new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema })));
    const transport = new HyperliquidGlobalTransport(quota, { egressKey, ownerId: 'worker' }, async () => Response.json({}));
    const stop = new AbortController();
    try {
      // A minute of background: 840 in 20s, expiring 2–12 s from now.
      const now = Date.now();
      const events = Array.from({ length: 42 }, (_, i) => {
        const expiresAt = now + 2_000 + Math.floor(i * 10_000 / 41);
        return { id: `seed-${i}`, kind: 'rest' as const, units: 20, reservedAt: expiresAt - 65_000, expiresAt };
      });
      await db.insert(schema.hyperliquidEgressQuota).values({ egressKey, events, updatedAt: new Date(now - 1) });

      const background = { granted: 0, refused: 0, errors: 0, grantedWhileSetup: 0 };
      let setupsRunning = 0;
      const loops = Array.from({ length: 8 }, async (_, n) => {
        const lane = new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))).bindUnscoped({ egressKey, ownerId: `harness-background-${n}` });
        while (!stop.signal.aborted) {
          try { await lane.acquireRest(20, Date.now() + 5000, 'background'); background.granted++; if (setupsRunning) background.grantedWhileSetup++; await wait(50); }
          catch (error) {
            const retry = sharedRestRetryAfterMs(error);
            if (retry === undefined) background.errors++; else background.refused++;
            await wait(Math.min(retry ?? 1000, 250 + Math.random() * 250));
          }
        }
      });
      // A live copy's orders: 20 in the live lane every 2 s.
      const live = { sent: 0, refused: 0 };
      const orders = (async () => {
        const bound = quota.bindUnscoped({ egressKey, ownerId: 'live' });
        while (!stop.signal.aborted) {
          try { await bound.acquireRest(20, Date.now() + 5000, 'live'); live.sent++; } catch { live.refused++; }
          await wait(2_000);
        }
      })();

      /** One setup step: claim its weight (when the meter can), wait as long
       * as told, then all of its charges at once; a refused charge fails the
       * attempt (as its 1 s in-window meter wait does) and it is tried again
       * when sharedCapacityWait says. */
      const step = async (weights: readonly number[]) => {
        const started = Date.now(), capacity = transport as unknown as { claimSetup?(w: number): Promise<number>; runSetup?<T>(work: () => Promise<T>): Promise<T> };
        const claim = async () => capacity.claimSetup ? capacity.claimSetup(weights.reduce((a, b) => a + b, 0)) : 0;
        const run = <T>(work: () => Promise<T>) => capacity.runSetup ? capacity.runSetup(work) : work();
        setupsRunning++;
        try {
          while (Date.now() - started < DEADLINE_MS) {
            const waitMs = await claim();
            if (waitMs > 0) { await wait(Math.min(waitMs + 250, DEADLINE_MS)); continue; }
            try {
              await run(async () => { for (const weight of weights) (await transport.currentQuota().acquireRest(weight, Date.now() + 5000)).dispatch(() => undefined); });
              return Date.now() - started;
            } catch (error) {
              const retry = sharedCapacityWait(error);
              if (!retry) throw error;
              await wait(Math.min(retry.retryMs, DEADLINE_MS));
            }
          }
          return Infinity;
        } finally { setupsRunning--; }
      };
      await wait(300);
      // The setup's account-mode attempt, and another setup's agent step beside it.
      const [modeMs, agentMs] = await Promise.all([step(ATTEMPT), step(AGENT)]);
      stop.abort(); await Promise.all([...loops, orders]);

      expect(modeMs).toBeLessThan(20_000);
      expect(agentMs).toBeLessThan(20_000);
      // Live orders all went out; background was refused, not the setups.
      expect(live.refused).toBe(0);
      expect(live.sent).toBeGreaterThan(3);
      expect(background.errors).toBe(0);
      expect(background.refused).toBeGreaterThan(0);
      // The setups' charges are the setup lane's (with their demand markers),
      // and the window never held more than the provider's 1200.
      const [row] = await db.select().from(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey));
      const at = Date.now(), held = row!.events.filter(e => e.kind === 'rest' && e.expiresAt > at);
      const setup = held.filter(e => e.id.startsWith('setup:'));
      expect(setup.map(e => e.units).sort((a, b) => a - b)).toEqual([...ATTEMPT, ...AGENT].sort((a, b) => a - b));
      expect(held.some(e => e.id.startsWith('setup-demand:'))).toBe(true);
      expect(held.reduce((sum, e) => sum + e.units, 0)).toBeLessThanOrEqual(1200);
    } finally {
      stop.abort();
      await db.delete(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey));
      await pool.end();
    }
  });
});
