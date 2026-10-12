import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@trading-dashboard/shared/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { sharedRestRetryAfterMs } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { closeTestDb, getTestDb } from './db-test-utils.js';

/** Every statement waits `rttMs` before it is sent: a database a network
 * round trip away (Stage's api to its Postgres is ~8 ms). `sent` counts them. */
function remote(rttMs: number) {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10 }), sent = { count: 0 };
  pool.on('connect', (client: PoolClient) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      sent.count++;
      if (typeof args.at(-1) === 'function') { setTimeout(() => query(...args), rttMs); return undefined; }
      return wait(rttMs).then(() => query(...args));
    };
  });
  return { pool, sent, quota: new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))) };
}
const RTT = 20, ORDER_METER_REQUESTS = 6;
let db: ReturnType<typeof getTestDb>;
beforeAll(() => { db = getTestDb(); });
afterAll(async () => { await closeTestDb(); });

describe('real-money meter requests beside a full background lane (2026-10-12 live_risk_stale)', () => {
  it('are not held up by background loops retrying a full lane, and each sends few statements', { timeout: 60_000 }, async () => {
    const egressKey = `contention-${randomUUID()}`, live = remote(RTT), background = remote(RTT);
    try {
      // Background fills its lane (840 of 1200), then eight loops keep asking
      // for more, as Stage's analytics, cohort, discovery and snapshot loops do.
      const lane = background.quota.bindUnscoped({ egressKey, ownerId: 'worker' });
      for (let i = 0; i < 7; i++) await lane.acquireRest(120, Date.now() + 5000, 'background');
      const stop = new AbortController(), outcome = { refused: 0, granted: 0 };
      const loops = Array.from({ length: 8 }, async () => {
        while (!stop.signal.aborted) {
          try { await lane.acquireRest(20, Date.now() + 5000, 'background'); outcome.granted++; }
          catch (error) { if (sharedRestRetryAfterMs(error) === undefined) throw error; outcome.refused++; }
          await wait(1);
        }
      });
      await wait(200);
      // One order's evidence: its meter requests, one at a time on the
      // original session (the eight of its two account sockets on Stage).
      const perRequest: number[] = [];
      let elapsed = 0;
      try {
        await new PostgresLiveRiskScope(live.pool).run({ userId: 1, network: 'mainnet', accountAddress: `0x${'22'.repeat(20)}` }, async (_scope, session) => {
          const meter = live.quota.bindOriginal(session, { egressKey, ownerId: 'api' }), started = performance.now();
          for (let i = 0; i < ORDER_METER_REQUESTS; i++) {
            const before = live.sent.count;
            await meter.acquireRest(2, Date.now() + 5000);
            perRequest.push(live.sent.count - before);
          }
          elapsed = performance.now() - started;
        });
      } finally { stop.abort(); await Promise.all(loops); }
      expect(outcome.refused).toBeGreaterThan(0);
      expect(outcome.granted).toBe(0);
      // Its own transaction: four lock proofs, BEGIN, two timeouts, the row
      // lock, the clock, the leases, the update and COMMIT (was 22).
      expect(Math.max(...perRequest)).toBeLessThanOrEqual(12);
      // Without waiting for the background loops' transactions on the meter's
      // row: those twelve round trips each, with room to spare (was 4.2 s at 15 ms).
      expect(elapsed).toBeLessThan(ORDER_METER_REQUESTS * 12 * RTT * 1.5);
      const [row] = await db.select().from(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey));
      expect(row!.events.reduce((sum, e) => sum + e.units, 0)).toBe(840 + 2 * ORDER_METER_REQUESTS);
    } finally {
      await db.delete(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey));
      await live.pool.end(); await background.pool.end();
    }
  });

  it('refuses a background request the meter just refused without a transaction, until room may exist', async () => {
    const egressKey = `known-full-${randomUUID()}`, background = remote(0);
    let clock = 1_000;
    const quota = new PostgresHyperliquidQuota(new UnitOfWork(drizzle(background.pool, { schema })), Date.now, () => clock);
    try {
      const lane = quota.bindUnscoped({ egressKey, ownerId: 'worker' });
      for (let i = 0; i < 7; i++) await lane.acquireRest(120, Date.now() + 5000, 'background');
      const refusal = await lane.acquireRest(20, Date.now() + 5000, 'background').catch((error: unknown) => error);
      const retry = sharedRestRetryAfterMs(refusal)!;
      expect(retry).toBeGreaterThan(0);
      let before = background.sent.count;
      // At least as heavy, while nothing can have expired: refused in-process.
      const again = await lane.acquireRest(40, Date.now() + 5000, 'background').catch((error: unknown) => error);
      expect(background.sent.count).toBe(before);
      expect(sharedRestRetryAfterMs(again)).toBe(retry);
      // A lighter one, or one past the retry time, still asks the meter.
      await lane.acquireRest(10, Date.now() + 5000, 'background').catch(() => undefined);
      expect(background.sent.count).toBeGreaterThan(before);
      before = background.sent.count; clock += retry;
      await lane.acquireRest(20, Date.now() + 5000, 'background').catch(() => undefined);
      expect(background.sent.count).toBeGreaterThan(before);
      // Live and page requests are never refused in-process.
      before = background.sent.count;
      await lane.acquireRest(20, Date.now() + 5000);
      expect(background.sent.count).toBeGreaterThan(before);
    } finally {
      await db.delete(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey));
      await background.pool.end();
    }
  });
});
