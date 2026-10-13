import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@trading-dashboard/shared/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { HyperliquidGlobalTransport, settleListAnswer } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { sharedRestRetryAfterMs } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { hyperliquidMeterComposition, type HyperliquidQuotaEvent } from '../src/hyperliquid/hyperliquid-global-quota.js';
// @ts-expect-error -- the harness's plain ESM helper (no declarations)
import { installDbRtt } from '../../../scripts/copy-harness/db-rtt.mjs';
import { closeTestDb, getTestDb } from './db-test-utils.js';
import { Testnet, database, setupIntent, worker } from './copy-setup-capacity-test-utils.js';

/**
 * The pre-mainnet gate of 2026-10-13 08:18–08:31 UTC (4th run, after
 * af53b416), in real time on the real Postgres meter: a new setup at
 * `funded` for 603 s, its account-mode claim (613) never once granted, 30
 * waits of `shared_capacity` (20 s, sometimes ~1 s that did not fit either),
 * background granted 130 and refused 13414.
 *
 * copy-setup-contention-postgres.spec.ts modelled background and a live
 * copy's orders only. The real worker and api also charge the wallet
 * network's meter (`<egress>:testnet`) with work that is neither: their
 * consumers below, at the lanes the code gives them (file:line at HEAD of
 * this branch) and at their rates on the gate (one setup, the harness's
 * testnet leader, a follower account, the owner's open pages):
 *
 * - the testnet leader source (copy-live-engine.provider.ts
 *   HyperliquidLiveSourceClient, walletGlobal.fetchInfo): its fills and TWAP
 *   lists every 60 s (120 each prepaid, settled to what they weighed with
 *   that process's next charge, as every list here);
 * - the follower monitor's receipts (copy.module.ts
 *   HyperliquidFollowerReceiptReader): fills and funding lists every 60 s;
 * - the follower snapshot collector (copy-worker.module.ts,
 *   fetchBackgroundInfo): an account observation's reads every 60 s;
 * - the worker's look at abandoned agent approvals (three left by earlier
 *   gate runs; each an agent observation of 80, once a minute);
 * - the owner's pages (api: WalletService's 15 s summary and 60 s history,
 *   fetchPageInfo): what the browser's /me/wallet polling asks for;
 * - a live order every 30 s (its demand, then its reads and POST in the
 *   live lane, as live-execution-runtime runs it);
 * - contention.mjs's eight background loops and two socket loops;
 * - every statement 8 ms late (db-rtt.mjs, the stage-like profile).
 *
 * Only Hyperliquid and Privy are fakes. The record (per class: held,
 * refused, oldest wait; every claim's decision) is printed for the report.
 */
const RTT_MS = 8, DEADLINE_MS = Number(process.env.SETUP_QUEUE_DEADLINE_MS ?? 240_000);
let db: ReturnType<typeof getTestDb>;
beforeAll(() => { db = getTestDb(); });
afterAll(async () => { await closeTestDb(); });

const INFO = 'https://api.hyperliquid-testnet.xyz/info', USER = `0x${'5a'.repeat(20)}`;
const LISTS = new Set(['userFillsByTime', 'userFunding', 'userNonFundingLedgerUpdates', 'userTwapSliceFillsByTime']);
/** Hyperliquid as these consumers see it: any read answers (lists empty). */
const provider: typeof fetch = async (_input, init) => {
  await wait(60);
  const type = JSON.parse(String(init?.body)).type as string;
  return Response.json(LISTS.has(type) ? [] : type === 'userRole' ? { role: 'user' } : {});
};
const post = (type: string, extra: Record<string, unknown> = {}) => ({ method: 'POST', body: JSON.stringify({ type, user: USER, ...extra }) });
/** A list's answer settles its prepaid 120 down to what it weighed (20 for an empty one), with that process's next charge, as the clients do. */
const settled = async (response: Promise<Response>) => { const answered = await response; settleListAnswer(answered, 0); return answered; };

/** Per consumer: grants, refusals, and the longest any request waited from its first ask to its grant. */
type Stats = { granted: number; refused: number; failed: number; oldestWaitMs: number };
const stats = () => ({ granted: 0, refused: 0, failed: 0, oldestWaitMs: 0 }) as Stats;

describe('a copy setup beside the real worker\'s and api\'s consumers on the real Postgres meter (gate 2026-10-13 08:18)', () => {
  it('reaches running within a bounded time; live is never refused; pages are served within the page hold; 1200 holds', { timeout: DEADLINE_MS + 90_000 }, async () => {
    const restore = installDbRtt(pg.Client, RTT_MS);
    const egressKey = `setup-queue-${randomUUID()}`, pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 30 });
    const uow = () => new UnitOfWork(drizzle(pool, { schema }));
    const stop = new AbortController();
    const readRow = async () => (await drizzle(pool, { schema }).select().from(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey)))[0];
    const loops: Promise<unknown>[] = [];
    try {
      // contention.mjs's first minute: background at its 840, 20 at a time,
      // their 65 s lives ending evenly over the next 64 s.
      const now = Date.now();
      const events = Array.from({ length: 42 }, (_, i) => {
        const expiresAt = now + 1_000 + Math.floor(i * 63_000 / 41);
        return { id: `bg:seed-${i}`, kind: 'rest' as const, units: 20, reservedAt: expiresAt - 65_000, expiresAt };
      });
      await db.insert(schema.hyperliquidEgressQuota).values({ egressKey, events, updatedAt: new Date(now - 1) });

      const record: Record<string, Stats> = { background: stats(), sockets: stats(), source: stats(), receipts: stats(), snapshots: stats(), approvals: stats(), pages: stats(), live: stats() };
      let setupOpen = true, grantedWhileSetup = 0;
      // contention.mjs, as it runs (its own process: one meter object for every loop).
      const contention = new PostgresHyperliquidQuota(uow());
      for (let n = 0; n < 8; n++) loops.push((async () => {
        const bound = contention.bindUnscoped({ egressKey, ownerId: `harness-background-${n}` });
        while (!stop.signal.aborted) {
          try { (await bound.acquireRest(20, Date.now() + 5000, 'background')).dispatch(() => undefined); record.background!.granted++; if (setupOpen) grantedWhileSetup++; await wait(50); }
          catch (error) {
            const retry = sharedRestRetryAfterMs(error);
            if (retry === undefined) record.background!.failed++; else record.background!.refused++;
            await wait(Math.min(retry ?? 1000, 250 + Math.random() * 250));
          }
        }
      })());
      for (let n = 0; n < 2; n++) loops.push((async () => {
        const bound = contention.bindUnscoped({ egressKey, ownerId: `harness-socket-${n}` });
        while (!stop.signal.aborted) {
          try { const r = await bound.reserveSocket(Date.now() + 5000, 'testnet'); record.sockets!.granted++; await r.connection.cancelBeforeConnect(); }
          catch { record.sockets!.refused++; }
          await wait(4000);
        }
      })());

      // The worker's and the api's own transports on the same egress (each its own process's meter object).
      const workerSide = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(uow()), { egressKey, ownerId: 'worker-consumers' }, provider);
      const apiSide = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(uow()), { egressKey, ownerId: 'api' }, provider);
      /** One consumer's request: timed from its first ask to its grant; a refusal is counted, never fatal. */
      const timed = async (name: string, work: () => Promise<unknown>) => {
        const asked = Date.now();
        try { await work(); const s = record[name]!; s.granted++; s.oldestWaitMs = Math.max(s.oldestWaitMs, Date.now() - asked); }
        catch (error) { const s = record[name]!; if (sharedRestRetryAfterMs(error) !== undefined || String((error as Error)?.message).includes('quota_exhausted')) s.refused++; else s.failed++; s.oldestWaitMs = Math.max(s.oldestWaitMs, Date.now() - asked); }
      };
      const every = (ms: number, offset: number, work: () => Promise<unknown>) => loops.push((async () => {
        await wait(offset, undefined, { signal: stop.signal }).catch(() => undefined);
        while (!stop.signal.aborted) { await work(); await wait(ms, undefined, { signal: stop.signal }).catch(() => undefined); }
      })());
      // The testnet leader source: fills and TWAP slices, 120 each prepaid, every 60 s.
      every(60_000, 2_000, () => timed('source', async () => {
        for (const type of ['userFillsByTime', 'userTwapSliceFillsByTime']) await settled(workerSide.fetchInfo(INFO, post(type, { startTime: 0 })));
      }));
      // The follower monitor: one account's fills and funding receipts every 60 s.
      every(60_000, 20_000, () => timed('receipts', async () => {
        for (const type of ['userFillsByTime', 'userFunding']) await settled(workerSide.fetchEssentialInfo(INFO, post(type, { startTime: 0 })));
      }));
      // The follower snapshot collector: an account observation's reads (background) every 60 s.
      every(60_000, 35_000, () => timed('snapshots', async () => {
        for (const type of ['userRole', 'userAbstraction', 'userDexAbstraction', 'spotClearinghouseState', 'perpDexs', 'spotMeta', 'allPerpMetas']) await workerSide.fetchBackgroundInfo(INFO, post(type));
      }));
      // The worker's look at agents whose approval was unknown when their
      // setup ended (copy-live-setup reconcileAbandonedApprovals: a few a pass,
      // each once a minute, for three days): three left by earlier gate runs,
      // each an agent observation (userRole + extraAgents), in the background
      // lane where the code runs it there (runBackground), unlabelled before.
      every(20_000, 7_000, () => timed('approvals', async () => {
        const look = () => workerSide.fetchInfoBatch(INFO, [{ type: 'userRole', user: USER }, { type: 'extraAgents', user: USER }], { maxWaitMs: 0 });
        const background = (workerSide as unknown as { runBackground?: <T>(work: () => Promise<T>) => Promise<T> }).runBackground;
        await (background ? background.call(workerSide, look) : look());
      }));
      // The owner's open pages (api): the wallet summary every 15 s, its history every 60 s.
      every(15_000, 5_000, () => timed('pages', () => Promise.all(['clearinghouseState', 'spotClearinghouseState'].map(type => apiSide.fetchPageInfo(INFO, post(type))))));
      every(60_000, 10_000, () => timed('pages', () => settled(apiSide.fetchPageInfo(INFO, post('userNonFundingLedgerUpdates', { startTime: 0 })))));
      // A live order every 30 s: its demand before its locks, then its evidence and POST in the live lane.
      every(30_000, 12_000, () => timed('live', async () => {
        const token = await workerSide.claimLive(83, Date.now() + 5000);
        const run = async () => {
          await workerSide.fetchInfoBatch(INFO, [{ type: 'userRole', user: USER }, { type: 'extraAgents', user: USER }, { type: 'clearinghouseState', user: USER }], { maxWaitMs: 0 });
          (await workerSide.currentQuota().acquireRest(1, Date.now() + 5000, 'live')).dispatch(() => undefined);
        };
        await (token ? workerSide.runLive(token, run) : run());
      }));

      // The worker's setup service (its own meter object), as copy.module wires it.
      const setupId = randomUUID(), intent = setupIntent(setupId, Date.now()), rows = database(intent, setupId, Date.now()), signed: string[] = [];
      const { service } = worker(new PostgresHyperliquidQuota(uow()), new Testnet(), rows, signed, egressKey);
      const decisions: { at: number; stage: string; wait: unknown; meter: unknown }[] = [];
      const transition = rows.setupRepository.transition;
      rows.setupRepository.transition = async (row, changes) => {
        const result = await transition(row, changes);
        if (changes.lastWait || changes.stage) {
          const row = await readRow();
          decisions.push({ at: Date.now() - now, stage: changes.stage ?? rows.rows.setup.stage, wait: changes.lastWait ?? null, meter: hyperliquidMeterComposition((row?.events ?? []) as HyperliquidQuotaEvent[], Date.now()) });
        }
        return result;
      };
      // The meter by class, sampled every second: what each held (mean, max) and the peak.
      const held: Record<string, { sum: number; max: number }> = {};
      let samples = 0, peak = 0, grants = 0;
      loops.push((async () => {
        while (!stop.signal.aborted) {
          const row = await readRow(), at = Date.now(), events = (row?.events ?? []) as HyperliquidQuotaEvent[];
          const c = hyperliquidMeterComposition(events, at) as unknown as Record<string, unknown>;
          samples++; peak = Math.max(peak, c.total as number);
          grants = Math.max(grants, events.filter(e => e.id.startsWith('setup-demand:') && e.id.endsWith(':g') && e.expiresAt > at).length);
          for (const key of ['background', 'other', 'live', 'page'] as const) { const v = (c[key] as number | undefined) ?? 0, h = held[key] ??= { sum: 0, max: 0 }; h.sum += v; h.max = Math.max(h.max, v); }
          const setupHeld = Object.values(c.setup as Record<string, number>).reduce((a, b) => a + b, 0), h = held.setup ??= { sum: 0, max: 0 }; h.sum += setupHeld; h.max = Math.max(h.max, setupHeld);
          await wait(1_000);
        }
      })());

      const started = Date.now(), errors: string[] = [];
      while (Date.now() - started < DEADLINE_MS && rows.rows.setup.stage !== 'running') {
        await service.tick().catch(error => { errors.push(String(error?.message ?? error)); });
        await wait(1_000);
      }
      const elapsed = Date.now() - started;
      setupOpen = false;
      stop.abort(); await Promise.all(loops);
      const classes = Object.fromEntries(Object.entries(held).map(([k, v]) => [k, { meanHeld: Math.round(v.sum / Math.max(1, samples)), maxHeld: v.max }]));
      const report = JSON.stringify({ elapsed, stage: rows.rows.setup.stage, stages: rows.rows.stages, peak, grantsSeen: grants, grantedWhileSetup, held: classes, consumers: record, decisions }, null, 1);
      console.log(report);
      // SETUP_QUEUE_RECORD: also written to that file (a passing run's output is not printed).
      if (process.env.SETUP_QUEUE_RECORD) writeFileSync(process.env.SETUP_QUEUE_RECORD, report);

      expect(errors).toEqual([]);
      expect(rows.rows.stages.map(s => s.stage)).toEqual(['mode_set', 'agent_active', 'builder_ready', 'running']);
      expect(elapsed).toBeLessThan(180_000);
      expect(signed).toEqual(['HyperliquidTransaction:UserSetAbstraction', 'HyperliquidTransaction:ApproveAgent']);
      // Live first: never refused.
      expect(record.live!.refused + record.live!.failed).toBe(0);
      expect(record.source!.refused + record.source!.failed).toBe(0);
      // Pages are held back for a waiting setup at most the page hold, then served: none gave up.
      expect(record.pages!.failed + record.pages!.refused).toBe(0);
      expect(record.pages!.oldestWaitMs).toBeLessThan(6_000);
      expect(record.background!.failed).toBe(0);
      expect(peak).toBeLessThanOrEqual(1200);
    } finally {
      stop.abort();
      await Promise.allSettled(loops);
      restore();
      await db.delete(schema.hyperliquidWsLeases).where(eq(schema.hyperliquidWsLeases.egressKey, egressKey));
      await db.delete(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey));
      await pool.end();
    }
  });
});
