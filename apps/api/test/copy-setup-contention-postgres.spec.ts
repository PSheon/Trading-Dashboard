import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@trading-dashboard/shared/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { sharedRestRetryAfterMs } from '../src/hyperliquid/hyperliquid-capacity-error.js';
// @ts-expect-error -- the harness's plain ESM helper (no declarations)
import { installDbRtt } from '../../../scripts/copy-harness/db-rtt.mjs';
import { closeTestDb, getTestDb } from './db-test-utils.js';
import { Testnet, database, setupIntent, worker } from './copy-setup-capacity-test-utils.js';

/**
 * The pre-mainnet gate of 2026-10-13 06:51–07:03 UTC, in real time on the
 * real Postgres meter: `copy_setup_running FAIL funded (hyperliquid_busy)
 * after 603 s`, its last_wait alternating between the claim's answer
 * (`shared:setup`, retryMs ~63.5 s) and a plain 65 s refusal partway
 * through the attempt.
 *
 * Everything is the real code: CopyLiveSetupService's funded → mode_set →
 * agent_active steps with the real account-mode client, absence reader and
 * HyperliquidGlobalTransport on PostgresHyperliquidQuota, ticked every 1 s as
 * the copy engine's pass ticks it; contention.mjs's loops exactly as it runs
 * them (eight background loops asking 20, a refusal retried after
 * min(retryAfter, 250–500 ms); two socket loops); every statement 8 ms late
 * (db-rtt.mjs, the stage-like profile); a live copy's orders beside it. The
 * background ahead of the setup is a full minute's 840, expiring evenly over
 * the next 64 s, as contention.mjs leaves it after its first minute.
 * Only Hyperliquid and Privy are fakes.
 */
const RTT_MS = 8, DEADLINE_MS = 170_000;
let db: ReturnType<typeof getTestDb>;
beforeAll(() => { db = getTestDb(); });
afterAll(async () => { await closeTestDb(); });

type Breakdown = Record<string, number>;
/** The meter's live REST units by ticket kind (what each decision saw). */
function breakdown(events: readonly { id: string; kind: string; units: number; expiresAt: number }[], at: number): Breakdown {
  const out: Breakdown = { total: 0 };
  for (const e of events) {
    if (e.kind !== 'rest' || e.expiresAt <= at) continue;
    const kind = e.id.startsWith('setup-demand:') ? 'setupDemand' : e.id.startsWith('setup:') ? 'setup' : e.id.startsWith('live-demand:') ? 'liveDemand'
      : e.id.startsWith('live:') ? 'live' : e.id.startsWith('seed-') || e.id.startsWith('bg') ? 'background' : 'other';
    out[kind] = (out[kind] ?? 0) + e.units; out.total += e.units;
  }
  return out;
}

describe('a copy setup beside contention.mjs on the real Postgres meter (gate 2026-10-13 06:51)', () => {
  it('reaches running within a bounded time; background is refused first; the window never passes 1200', { timeout: DEADLINE_MS + 60_000 }, async () => {
    const restore = installDbRtt(pg.Client, RTT_MS);
    const egressKey = `setup-contention-${randomUUID()}`, pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 24 });
    const uow = () => new UnitOfWork(drizzle(pool, { schema }));
    const stop = new AbortController();
    const readRow = async () => (await drizzle(pool, { schema }).select().from(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey)))[0];
    try {
      // contention.mjs's first minute: background at its 840, 20 at a time,
      // their 65 s lives ending evenly over the next 64 s.
      const now = Date.now();
      const events = Array.from({ length: 42 }, (_, i) => {
        const expiresAt = now + 1_000 + Math.floor(i * 63_000 / 41);
        return { id: `seed-${i}`, kind: 'rest' as const, units: 20, reservedAt: expiresAt - 65_000, expiresAt };
      });
      await db.insert(schema.hyperliquidEgressQuota).values({ egressKey, events, updatedAt: new Date(now - 1) });

      // contention.mjs, as it runs (one meter object for every loop).
      const contention = new PostgresHyperliquidQuota(uow());
      const counts = { granted: 0, refused: 0, errors: 0, sockets: 0, socketRefused: 0, grantedWhileSetup: 0 };
      let setupOpen = true;
      const background = async (n: number) => {
        const bound = contention.bindUnscoped({ egressKey, ownerId: `harness-background-${n}` });
        while (!stop.signal.aborted) {
          try { (await bound.acquireRest(20, Date.now() + 5000, 'background')).dispatch(() => undefined); counts.granted++; if (setupOpen) counts.grantedWhileSetup++; await wait(50); }
          catch (error) {
            const retry = sharedRestRetryAfterMs(error);
            if (retry === undefined) counts.errors++; else counts.refused++;
            await wait(Math.min(retry ?? 1000, 250 + Math.random() * 250));
          }
        }
      };
      const sockets = async (n: number) => {
        const bound = contention.bindUnscoped({ egressKey, ownerId: `harness-socket-${n}` });
        while (!stop.signal.aborted) {
          try { const r = await bound.reserveSocket(Date.now() + 5000, 'testnet'); counts.sockets++; await r.connection.cancelBeforeConnect(); }
          catch { counts.socketRefused++; }
          await wait(4000);
        }
      };
      const loops = [...Array.from({ length: 8 }, (_, n) => background(n)), ...Array.from({ length: 2 }, (_, n) => sockets(n))];

      // The worker: the setup service on the same meter (its own process's meter object).
      const setupId = randomUUID(), intent = setupIntent(setupId, Date.now()), rows = database(intent, setupId, Date.now()), signed: string[] = [];
      const { service, quota } = worker(new PostgresHyperliquidQuota(uow()), new Testnet(), rows, signed, egressKey);
      // Each decision the setup records, with what the meter held then.
      const decisions: { at: number; stage: string; issue: string | null; wait: unknown; meter: Breakdown }[] = [];
      const transition = rows.setupRepository.transition;
      rows.setupRepository.transition = async (row, changes) => {
        const result = await transition(row, changes);
        if (changes.lastWait || changes.stage || changes.issue !== undefined) {
          const row = await readRow();
          decisions.push({ at: Date.now() - now, stage: changes.stage ?? rows.rows.setup.stage, issue: changes.issue ?? null, wait: changes.lastWait ?? null, meter: breakdown(row?.events ?? [], Date.now()) });
        }
        return result;
      };
      // A live copy's orders: an order's live-lane charges every 10 s.
      const live = { sent: 0, refused: 0 };
      const orders = (async () => {
        const bound = quota.bindUnscoped({ egressKey, ownerId: 'live' });
        while (!stop.signal.aborted) {
          await wait(10_000);
          for (const weight of [21, 22, 1]) {
            try { (await bound.acquireRest(weight, Date.now() + 5000, 'live')).dispatch(() => undefined); live.sent++; } catch { live.refused++; }
          }
        }
      })();
      // The meter's peak (sampled), never above the provider's 1200.
      let peak = 0;
      const sampler = (async () => { while (!stop.signal.aborted) { const row = await readRow(); peak = Math.max(peak, breakdown(row?.events ?? [], Date.now()).total); await wait(500); } })();

      const started = Date.now(), errors: string[] = [];
      while (Date.now() - started < DEADLINE_MS && rows.rows.setup.stage !== 'running') {
        await service.tick().catch(error => { errors.push(String(error?.message ?? error)); });
        await wait(1_000);
      }
      const elapsed = Date.now() - started;
      setupOpen = false;
      stop.abort(); await Promise.all([...loops, orders, sampler]);
      // The record (the report's per-decision breakdown).
      console.log(JSON.stringify({ elapsed, stages: rows.rows.stages, counts, live, peak, decisions }, null, 1));

      expect(errors).toEqual([]);
      expect(rows.rows.stages.map(s => s.stage)).toEqual(['mode_set', 'agent_active', 'builder_ready', 'running']);
      // Bounded: the full minute ahead of its mode step drains once, and its
      // agent step's 81 waits at most for the window below the live reserve
      // (before: at funded for 603 s on the gate, 141 s here, never running).
      expect(elapsed).toBeLessThan(150_000);
      // It claims again at least every 20 s while it waits (SETUP_CLAIM_RENEW_MS):
      // its marker never lapses and lets background back in between two claims.
      const waits = decisions.flatMap(d => d.wait ? [d.wait as { retryMs: number; bucket?: string }] : []);
      expect(waits.length).toBeGreaterThan(0);
      for (const w of waits) expect(w.retryMs).toBeLessThanOrEqual(20_000);
      expect(signed).toEqual(['HyperliquidTransaction:UserSetAbstraction', 'HyperliquidTransaction:ApproveAgent']);
      expect(live.refused).toBe(0);
      expect(counts.errors).toBe(0);
      expect(counts.refused).toBeGreaterThan(counts.grantedWhileSetup);
      expect(peak).toBeLessThanOrEqual(1200);
    } finally {
      stop.abort();
      restore();
      await db.delete(schema.hyperliquidWsLeases).where(eq(schema.hyperliquidWsLeases.egressKey, egressKey));
      await db.delete(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey));
      await pool.end();
    }
  });
});
