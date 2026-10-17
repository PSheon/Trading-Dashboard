import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
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
 * frees up is its first. Gate 11 run 6 (2026-10-16): with real 60 s charges
 * that need took longer to free up than a pass waits, and each pass's new
 * claim queued behind its own abandoned ones; the claim is now keyed by the
 * order across passes and released when a pass is over.
 */
const RTT_MS = 8, INFO = 'https://api.hyperliquid-testnet.xyz/info';
let db: ReturnType<typeof getTestDb>;
beforeAll(() => { db = getTestDb(); });
afterAll(async () => { await closeTestDb(); });

const ACCOUNT = '0x00000000000000000000000000000000000000a1';
const record = (now: number) => ({ key: `testnet:${ACCOUNT}:0x${'1'.repeat(32)}`, state: 'filled', createdAt: now - 20_000, updatedAt: now - 15_000, expiresAfter: now - 10_000,
  authorization: { network: 'testnet', accountAddress: ACCOUNT }, action: { orders: [{ a: 0, c: `0x${'1'.repeat(32)}` }] },
  outcome: { state: 'filled', filledSize: '0.001' } }) as unknown as LiveExecutionRecord;

describe('terminal settlement beside saturated background and page lanes on the shared Postgres meter', () => {
  it('its fill scan goes out once its need has freed up, across the loop\'s passes, never queued behind its own earlier pass', { timeout: 120_000 }, async () => {
    // Gate 11 run 6 (2026-10-16): every charge in the window lives 60 s, so
    // room frees at ~20 units/s, and a settlement's need (~500) takes ~25 s to
    // free up: more than its pass waits (SETTLEMENT_CLAIM_WAIT_MS, 15 s). Each
    // pass (every 3 s) claimed under a new token and gave up at once, its
    // abandoned claim kept its need outstanding, and the next pass was
    // quoted behind it: refused for minutes while the room sat free.
    const restore = installDbRtt(pg.Client, RTT_MS);
    const egressKey = `settle-lane-${randomUUID()}`, pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 16 });
    const uow = () => new UnitOfWork(drizzle(pool, { schema }));
    const raw = vi.fn<typeof fetch>(async () => Response.json([]));
    const transport = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(uow()), { egressKey, ownerId: 'api' }, raw);
    const stop = new AbortController();
    try {
      // The whole window taken, as on the gate: background at its cap (840)
      // and pages the rest (360), charged over the last minute, so 20 comes
      // free each second.
      const now = Date.now();
      const events = Array.from({ length: 60 }, (_, i) => ({ id: i < 42 ? `seed-${i}` : `page:${randomUUID()}`, kind: 'rest' as const, units: 20,
        reservedAt: now - 60_000 + (i + 1) * 1000, expiresAt: now + (i + 1) * 1000 }));
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
        for (let i = 0; i < 2; i++) await transport.runOwned('settle', () => transport.fetchInfo(INFO, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'userFillsByTime', user: ACCOUNT, startTime: now - 120_000, endTime: now }) }));
        scanned = Date.now();
      } };
      // Stops at the evidence prepayment (the local bucket): the meter is what this test is about.
      const budget = { refillMs: () => { throw Error('evidence stage reached'); } } as unknown as RequestBudgeterService;
      const settler = new CopyLiveSettler('testnet', pool, transport, budget, scanner);
      vi.spyOn(settler as unknown as { record(key: string): Promise<LiveExecutionRecord> }, 'record').mockResolvedValue(record(now));
      const claimed = vi.spyOn(transport, 'claimLive');
      // The api's loop: a pass every 3 s while the settlement is pending.
      const started = Date.now();let passes = 0, refusals = 0;
      for (; scanned === undefined && Date.now() - started < 90_000; passes++) {
        const passAt = Date.now();
        try {
          await settler.settle({ userId: 1, accountId: randomUUID(), accountAddress: ACCOUNT, sourceNetwork: 'testnet',
            leaderAddress: '0x00000000000000000000000000000000000000b2', key: record(now).key });
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'evidence stage reached') { expect(sharedRestRetryAfterMs(error)).toBeDefined(); refusals++; }
        }
        await wait(Math.max(0, passAt + 3000 - Date.now()));
      }
      expect(scanned).toBeDefined();
      // Its need frees up at 20 a second (its marker's unit too); then a pass at most and the reads.
      const need = claimed.mock.calls[0]![0];
      expect(need).toBeGreaterThan(240);
      expect(scanned! - started).toBeLessThan((need + 1) * 50 + 3000 + 5000);
      // Only the passes before its quote came within SETTLEMENT_CLAIM_WAIT_MS gave up.
      expect(refusals).toBeLessThanOrEqual(Math.ceil(Math.max(0, (need + 1) * 50 - 15_000) / 3000) + 1);
      expect(raw.mock.calls.filter(([, init]) => (JSON.parse(init?.body as string) as { type: string }).type === 'userFillsByTime')).toHaveLength(2);
      // The lanes it went ahead of were asking all along: every 20 that freed up was its, not theirs.
      expect(counts.refused).toBeGreaterThan(0);
      // Its pass is over: its claim keeps nothing free.
      const [row] = await db.select().from(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey));
      expect((row!.events as { id: string }[]).filter(e => e.id.startsWith('live-demand:'))).toEqual([]);
      stop.abort(); await Promise.all(loops);
    } finally {
      stop.abort(); restore(); await pool.end();
    }
  });

  it('its claim is recorded on a full window even when a page takes every unit that frees up first, and its read goes out', { timeout: 30_000 }, async () => {
    // CI 2026-10-14 (5 of 8 runs): the claim's marker went in only when a unit
    // was free, the pages took each freed 20 first, and once the room due to
    // free up in time was gone the claim was refused at ~9 s. Here the pages
    // always win that race: each time the claim waits, a page asks first.
    const egressKey = `settle-marker-${randomUUID()}`, pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
    const uow = () => new UnitOfWork(drizzle(pool, { schema }));
    try {
      // The window full: 600 freeing 20 every 100 ms (3 s in all), 600 held for a minute.
      const now = Date.now();
      const events = [...Array.from({ length: 30 }, (_, i) => ({ id: `page:${randomUUID()}`, kind: 'rest' as const, units: 20, reservedAt: now - 60_000 + i * 100, expiresAt: now + (i + 1) * 100 })),
        { id: 'held', kind: 'rest' as const, units: 600, reservedAt: now - 5_000, expiresAt: now + 55_000 }];
      await db.insert(schema.hyperliquidEgressQuota).values({ egressKey, events, updatedAt: new Date(now - 1) });
      const page = new PostgresHyperliquidQuota(uow()).bindUnscoped({ egressKey, ownerId: 'harness-page' });
      let pages = 0;
      const sleep = async (ms: number) => {
        await wait(ms);
        try { (await page.acquireRest(20, Date.now() + 5000, 'page')).dispatch(() => undefined); pages++; } catch { /* refused: the room is the claim's */ }
      };
      const raw = vi.fn<typeof fetch>(async () => Response.json([]));
      const transport = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(uow()), { egressKey, ownerId: 'worker' }, raw, Date.now, sleep);
      const started = Date.now();
      // Before: refused at ~3 s (hyperliquid_quota_exhausted), every freed unit a page's.
      const token = await transport.claimLive(200, started + 15_000);
      expect(token).toBeDefined();
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(pages).toBe(0);
      await transport.runOwned('settle', () => transport.runLive(token!, () => transport.fetchInfo(INFO, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'userFillsByTime', user: ACCOUNT, startTime: now - 120_000, endTime: now }) })));
      expect(raw).toHaveBeenCalledTimes(1);
    } finally {
      await pool.end();
    }
  });
  it('a claim that gives up keeps nothing free; a keyed one keeps one place for its key\'s next pass until it is released', { timeout: 30_000 }, async () => {
    // Gate 11 (2026-10-16): abandoned claims, a new token every 3 s, held
    // 530–809 of need outstanding, and the next order was quoted 57.9 s and refused.
    const egressKey = `settle-release-${randomUUID()}`, pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
    const uow = () => new UnitOfWork(drizzle(pool, { schema }));
    try {
      const now = Date.now();
      await db.insert(schema.hyperliquidEgressQuota).values({ egressKey, events: [{ id: 'held', kind: 'rest', units: 1200, reservedAt: now - 1_000, expiresAt: now + 59_000 }], updatedAt: new Date(now - 1) });
      const transport = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(uow()), { egressKey, ownerId: 'api' }, vi.fn<typeof fetch>());
      const markers = async () => {
        const [row] = await db.select().from(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey));
        return (row!.events as { id: string }[]).filter(e => e.id.startsWith('live-demand:')).map(e => e.id.split(':')[2]);
      };
      const refused = async (work: Promise<unknown>) => { try { await work; } catch (error) { return sharedRestRetryAfterMs(error); } return undefined; };
      expect(await refused(transport.claimLive(500, Date.now() + 1_000))).toBeGreaterThan(1_000);
      expect(await markers()).toEqual([]);
      const key = record(now).key;
      for (let pass = 0; pass < 3; pass++) expect(await refused(transport.claimLive(500, Date.now() + 1_000, key))).toBeGreaterThan(1_000);
      const kept = await markers();
      expect(kept).toHaveLength(1);
      await transport.releaseLive(key);
      expect(await markers()).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});
