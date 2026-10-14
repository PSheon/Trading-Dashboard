import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@trading-dashboard/shared/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { sharedRestRetryAfterMs } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import type { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { CopyLiveSettler } from '../src/copy/live-worker/copy-live-settler.js';
import type { LiveExecutionRecord } from '../src/copy/live/live-execution.js';
// @ts-expect-error -- the harness's plain ESM helper (no declarations)
import { installDbRtt } from '../../../scripts/copy-harness/db-rtt.mjs';
import { closeTestDb, getTestDb } from './db-test-utils.js';

/**
 * Gate run 10: a copy's second order waited over two minutes for its first
 * order's settlement, every attempt refused on the shared meter
 * (`hyperliquid_quota_exhausted`) while background and page traffic kept
 * the window full. Here, on the real Postgres meter with the stage-like
 * 8 ms per statement: background loops at their cap and page loops that
 * wait for room keep the whole window taken, and a terminal settlement's
 * fill scan (two list reads) must go out within seconds, never refused.
 *
 * Before: the settlement announced no need; its reads were refused at once
 * on a full window. After: it claims its need (claimLive) and the room that
 * frees up is its first.
 */
const RTT_MS = 8, INFO = 'https://api.hyperliquid-testnet.xyz/info', BOUND_MS = 20_000;
let db: ReturnType<typeof getTestDb>;
beforeAll(() => { db = getTestDb(); });
afterAll(async () => { await closeTestDb(); });

const ACCOUNT = '0x00000000000000000000000000000000000000a1';
const record = (now: number) => ({ key: `testnet:${ACCOUNT}:0x${'1'.repeat(32)}`, state: 'filled', createdAt: now - 20_000, updatedAt: now - 15_000, expiresAfter: now - 10_000,
  authorization: { network: 'testnet', accountAddress: ACCOUNT }, action: { orders: [{ a: 0, c: `0x${'1'.repeat(32)}` }] },
  outcome: { state: 'filled', filledSize: '0.001' } }) as unknown as LiveExecutionRecord;

describe('terminal settlement beside saturated background and page lanes on the shared Postgres meter', () => {
  it('its fill scan goes out within seconds and is never refused', { timeout: BOUND_MS + 30_000 }, async () => {
    const restore = installDbRtt(pg.Client, RTT_MS);
    const egressKey = `settle-lane-${randomUUID()}`, pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 16 });
    const uow = () => new UnitOfWork(drizzle(pool, { schema }));
    const raw = vi.fn<typeof fetch>(async () => Response.json([]));
    const transport = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(uow()), { egressKey, ownerId: 'worker' }, raw);
    const stop = new AbortController();
    try {
      // The whole window taken: background at its cap (840) and pages the
      // rest (360), charged over the last minute, so it comes free a little at a time.
      const now = Date.now();
      const events = Array.from({ length: 60 }, (_, i) => ({ id: i < 42 ? `seed-${i}` : `page:${randomUUID()}`, kind: 'rest' as const, units: 20,
        reservedAt: now - 60_000 + i * 150, expiresAt: now + i * 150 }));
      await db.insert(schema.hyperliquidEgressQuota).values({ egressKey, events, updatedAt: new Date(now - 1) });

      const counts = { background: 0, page: 0, refused: 0 }, contention = new PostgresHyperliquidQuota(uow());
      const loops = [...Array.from({ length: 6 }, async (_, n) => {
        const bound = contention.bindUnscoped({ egressKey, ownerId: `harness-background-${n}` });
        while (!stop.signal.aborted) {
          try { (await bound.acquireRest(20, Date.now() + 5000, 'background')).dispatch(() => undefined); counts.background++; await wait(50); }
          catch (error) { counts.refused++; await wait(Math.min(sharedRestRetryAfterMs(error) ?? 250, 250)); }
        }
      }), ...Array.from({ length: 6 }, async (_, n) => {
        // Pages wait for room (fetchPageInfo's lane) and take it the moment it frees.
        const bound = contention.bindUnscoped({ egressKey, ownerId: `harness-page-${n}` });
        while (!stop.signal.aborted) {
          try { (await bound.acquireRest(20, Date.now() + 5000, 'page')).dispatch(() => undefined); counts.page++; }
          catch (error) { counts.refused++; await wait(Math.min(sharedRestRetryAfterMs(error) ?? 50, 50)); }
        }
      })];
      await wait(500);

      // The scan: its two list reads, as the follower receipt reader sends them.
      let scanned: number | undefined;
      const scanner = { runFor: async () => {
        for (let i = 0; i < 2; i++) await transport.fetchInfo(INFO, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'userFillsByTime', user: ACCOUNT, startTime: now - 120_000, endTime: now }) });
        scanned = Date.now();
      } };
      // Stops at the evidence prepayment (the local bucket): the meter is what this test is about.
      const budget = { refillMs: () => { throw Error('evidence stage reached'); } } as unknown as RequestBudgeterService;
      const settler = new CopyLiveSettler('testnet', pool, transport, budget, scanner);
      vi.spyOn(settler as unknown as { record(key: string): Promise<LiveExecutionRecord> }, 'record').mockResolvedValue(record(now));
      const started = Date.now();
      await expect(settler.settle({ userId: 1, accountId: randomUUID(), accountAddress: ACCOUNT, sourceNetwork: 'testnet',
        leaderAddress: '0x00000000000000000000000000000000000000b2', key: record(now).key })).rejects.toThrow('evidence stage reached');
      expect(scanned).toBeDefined();
      expect(scanned! - started).toBeLessThan(BOUND_MS);
      expect(raw.mock.calls.filter(([, init]) => (JSON.parse(init?.body as string) as { type: string }).type === 'userFillsByTime')).toHaveLength(2);
      // The lanes it went ahead of were asking all along (pages were granted, and refused).
      expect(counts.page).toBeGreaterThan(0); expect(counts.refused).toBeGreaterThan(0);
      stop.abort(); await Promise.all(loops);
    } finally {
      stop.abort(); restore(); await pool.end();
    }
  });
});
