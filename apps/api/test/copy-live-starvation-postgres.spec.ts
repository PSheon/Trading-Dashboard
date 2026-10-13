import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@trading-dashboard/shared/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { AppConfig } from '../src/config/app-config.js';
import { validateEnvironment } from '../src/config/runtime-config.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { HyperliquidGlobalTransport, settleListAnswer } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { sharedRestRetryAfterMs } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import type { HyperliquidQuotaEvent } from '../src/hyperliquid/hyperliquid-global-quota.js';
import { HyperliquidBudgetWait, liveBudget } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { walletNetworkHyperliquid, type WalletNetworkHyperliquid } from '../src/hyperliquid/wallet-network-hyperliquid.js';
import { HyperliquidLiveSourceClient } from '../src/copy/copy-live-source.client.js';
import { retryDelayMs } from '../src/copy/live-worker/copy-live-engine.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import { errorCode } from '../src/runtime/safe-error-text.js';
import { DEFAULT_LIVE_SETUP_TIMINGS } from '../src/config/live-timings.js';
// @ts-expect-error -- the harness's plain ESM helper (no declarations)
import { installDbRtt } from '../../../scripts/copy-harness/db-rtt.mjs';
import { closeTestDb, getTestDb } from './db-test-utils.js';
import { Testnet, database, setupIntent, worker } from './copy-setup-capacity-test-utils.js';

/**
 * The 7th pre-mainnet gate run (2026-10-13 11:03–11:17 UTC, stage-like:
 * every statement 8 ms late, contention.mjs on), in real time on the real
 * Postgres meter. The setup reached running after 520 s; the leader then
 * opened BTC and the copy never sent it:
 *
 * - the worker's testnet bucket (wallet-network-hyperliquid: rate 300,
 *   burst 900) was the setup's and the orders' both, and the setup's mode
 *   (715) and agent (81) steps had just drained it: the leader's source
 *   read (240, at most 5 s) was refused (`live_budget_wait`) and the
 *   order's evidence prepay (568) waited 67.6 s;
 * - the order's follower observation was refused its socket connects by
 *   the shared meter (contention.mjs's two socket loops keep the 30 a
 *   minute full): `live_account_observation_unavailable`, twice;
 * - those counted as attempts and waited 10 s each, and the leg was
 *   refused once its signal was 120 s old.
 *
 * Here, the same: the setup (CopyLiveSetupService, its clients on the
 * bucket copy.module gives them, `setupBudget` where there is one, else the
 * wallet bucket as before), the worker's order bucket from
 * walletNetworkHyperliquid with its observers (the follower snapshot
 * collector and the receipts, background) and the leader's source read
 * (HyperliquidLiveSourceClient on that bucket, the live lane of the meter),
 * contention.mjs's loops, and a live order run as live-execution-runtime
 * runs it (its evidence prepaid from the order bucket within the signal,
 * its demand on the meter, its two accounts' observations' six live socket
 * connects and its reads and POST in the live lane), retried as the
 * engine retries (retryDelayMs), and, where the release has it, the
 * engine's standby keeping one order's need free on the meter while the
 * copy runs. The leader opens BTC FILL_AFTER_RUNNING_MS after the setup
 * reaches running (as in the gate). The fill must be read on the first
 * source pass after it, never refused, and the order go out within
 * ORDER_SLA_MS of that read on its first attempt, none of its socket
 * connects refused.
 * Only Hyperliquid and Privy are fakes.
 */
const RTT_MS = 8, SETUP_DEADLINE_MS = Number(process.env.STARVATION_SETUP_DEADLINE_MS ?? 240_000);
/** An open's signal age (copyRiskLimits maxSignalAgeSeconds 120). */
const SIGNAL_AGE_MS = 120_000;
/** From the signal read to the order's POST: its evidence, demand, observations and POST, none of them waiting behind setups or background. */
const ORDER_SLA_MS = 10_000;
/** When the leader opens BTC after the setup reached running (the gate: ~74 s). */
const FILL_AFTER_RUNNING_MS = Number(process.env.STARVATION_FILL_AFTER_MS ?? 70_000);
/** One order's evidence on the order bucket (one account and the ratio leader) and on the meter. */
const ORDER_WEIGHT = 568;
/** The leader's source poll (COPY_LIVE_TESTNET_SOURCE_INTERVAL_MS, shortened from 60 s to keep the run short). */
const SOURCE_POLL_MS = 15_000;
let db: ReturnType<typeof getTestDb>;
beforeAll(() => { db = getTestDb(); });
afterAll(async () => { await closeTestDb(); });

const INFO = 'https://api.hyperliquid-testnet.xyz/info', USER = `0x${'5a'.repeat(20)}`, LEADER = `0x${'4c'.repeat(20)}`;
const LISTS = new Set(['userFillsByTime', 'userFunding', 'userNonFundingLedgerUpdates', 'userTwapSliceFillsByTime']);
/** Hyperliquid as these consumers see it: any read answers (lists empty). */
const provider: typeof fetch = async (_input, init) => {
  await wait(60);
  const type = JSON.parse(String(init?.body)).type as string;
  return Response.json(LISTS.has(type) ? [] : type === 'userRole' ? { role: 'user' } : {});
};
const post = (type: string, extra: Record<string, unknown> = {}) => ({ method: 'POST', body: JSON.stringify({ type, user: USER, ...extra }) });
const settled = async (response: Promise<Response>) => { const answered = await response; settleListAnswer(answered, 0); return answered; };
/** What the account observer throws when its socket connect was refused underneath (LiveObservationUnavailable). */
const unavailable = (cause: unknown) => Object.assign(new LiveBoundaryError('live_account_observation_unavailable'), { cause });

describe('a live copy\'s first order right after its setup reached running, beside the setup\'s steps, the observers and contention.mjs on the real Postgres meter (gate 2026-10-13 11:13, 7th run)', () => {
  it('the leader\'s open is read and sent within the SLA: its source read and evidence never wait behind the setup, its sockets are never refused, 1200 holds', { timeout: SETUP_DEADLINE_MS + FILL_AFTER_RUNNING_MS + SIGNAL_AGE_MS + 120_000 }, async () => {
    const restore = installDbRtt(pg.Client, RTT_MS);
    const base = `starvation-${randomUUID()}`, pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 30 });
    const uow = () => new UnitOfWork(drizzle(pool, { schema }));
    // The worker's wallet network as HyperliquidModule builds it on testnet.
    const config = new AppConfig(validateEnvironment({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', NODE_ENV: 'test', HYPERLIQUID_EGRESS_KEY: base,
      HYPERLIQUID_NETWORK: 'testnet', HYPERLIQUID_STARTUP_PACE_SECONDS: '0' }));
    const main = new RequestBudgeterService(config);
    const wallet = walletNetworkHyperliquid(config, main, {} as HyperliquidGlobalTransport, new PostgresHyperliquidQuota(uow()));
    const orders = wallet.budget, setupBucket = (wallet as Partial<WalletNetworkHyperliquid>).setupBudget ?? wallet.budget;
    const egressKey = wallet.config.value.hyperliquid.egressKey!;
    const stop = new AbortController(), loops: Promise<unknown>[] = [];
    const readRow = async () => (await drizzle(pool, { schema }).select().from(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey)))[0];
    const every = (ms: number, offset: number, work: () => Promise<unknown>) => loops.push((async () => {
      await wait(offset, undefined, { signal: stop.signal }).catch(() => undefined);
      while (!stop.signal.aborted) { await work().catch(() => undefined); await wait(ms, undefined, { signal: stop.signal }).catch(() => undefined); }
    })());
    try {
      // contention.mjs's first minute: background at its 840.
      const now = Date.now();
      const events = Array.from({ length: 42 }, (_, i) => {
        const expiresAt = now + 1_000 + Math.floor(i * 63_000 / 41);
        return { id: `bg:seed-${i}`, kind: 'rest' as const, units: 20, reservedAt: expiresAt - 65_000, expiresAt };
      });
      await db.insert(schema.hyperliquidEgressQuota).values({ egressKey, events, updatedAt: new Date(now - 1) });
      const contention = new PostgresHyperliquidQuota(uow()), harness = { granted: 0, refused: 0, sockets: 0, socketsRefused: 0 };
      for (let n = 0; n < 8; n++) loops.push((async () => {
        const bound = contention.bindUnscoped({ egressKey, ownerId: `harness-background-${n}` });
        while (!stop.signal.aborted) {
          try { (await bound.acquireRest(20, Date.now() + 5000, 'background')).dispatch(() => undefined); harness.granted++; await wait(50); }
          catch (error) { harness.refused++; await wait(Math.min(sharedRestRetryAfterMs(error) ?? 1000, 250 + Math.random() * 250)); }
        }
      })());
      for (let n = 0; n < 2; n++) loops.push((async () => {
        const bound = contention.bindUnscoped({ egressKey, ownerId: `harness-socket-${n}` });
        while (!stop.signal.aborted) {
          try { const r = await bound.reserveSocket(Date.now() + 5000, 'testnet'); harness.sockets++; await r.connection.cancelBeforeConnect(); }
          catch { harness.socketsRefused++; }
          await wait(4000);
        }
      })());

      // The worker's own consumers on the order bucket and the wallet network's transport.
      const workerSide = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(uow()), { egressKey, ownerId: 'worker-consumers' }, provider);
      const observers = { receipts: 0, snapshots: 0, refused: 0 };
      // The follower monitor's receipts: fills and funding, background, every 60 s (most of the 240 refunded).
      every(60_000, 3_000, async () => {
        try {
          await liveBudget(orders, { lane: 'background', maxWaitMs: 5_000 })(240);
          for (const type of ['userFillsByTime', 'userFunding']) await settled(workerSide.fetchEssentialInfo(INFO, post(type, { startTime: 0 })));
          orders.adjust(-200); observers.receipts++;
        } catch { observers.refused++; }
      });
      // The follower snapshot collector: an account observation (background), its reads and three sockets, every 60 s.
      every(60_000, 25_000, async () => {
        try {
          await liveBudget(orders, { lane: 'background', maxWaitMs: 5_000 })(102);
          for (const type of ['userRole', 'userAbstraction', 'userDexAbstraction', 'spotClearinghouseState']) await workerSide.fetchBackgroundInfo(INFO, post(type));
          for (let i = 0; i < 3; i++) await (await workerSide.currentQuota().reserveSocket(Date.now() + 5000, 'testnet')).connection.cancelBeforeConnect();
          observers.snapshots++;
        } catch { observers.refused++; }
      });

      // The setup (the worker's setup service, its own meter object), its clients on the bucket copy.module gives them.
      const setupId = randomUUID(), intent = setupIntent(setupId, Date.now()), rows = database(intent, setupId, Date.now()), signed: string[] = [];
      const { service } = worker(new PostgresHyperliquidQuota(uow()), new Testnet(), rows, signed, egressKey,
        { budget: setupBucket, reserve: { maxWaitMs: DEFAULT_LIVE_SETUP_TIMINGS.stepBudgetMs.reserveWaitMs, queue: true, bucket: 'setup' }, sockets: true });
      // The meter's REST total, sampled every second: 1200 holds.
      let peak = 0;
      loops.push((async () => {
        while (!stop.signal.aborted) {
          const row = await readRow(), at = Date.now();
          peak = Math.max(peak, ((row?.events ?? []) as HyperliquidQuotaEvent[]).filter(e => e.kind === 'rest' && e.expiresAt > at).reduce((s, e) => s + e.units, 0));
          await wait(1_000);
        }
      })());

      const started = Date.now(), errors: string[] = [];
      while (Date.now() - started < SETUP_DEADLINE_MS && rows.rows.setup.stage !== 'running') {
        await service.tick().catch(error => { errors.push(String(error?.message ?? error)); });
        await wait(1_000);
      }
      const setupMs = Date.now() - started;
      expect(errors).toEqual([]);
      expect(rows.rows.setup.stage).toBe('running');

      // The copy runs: the engine keeps one order's need free on the meter
      // (its standby, every 10 s; a release without one has nothing to keep),
      // and reads the leader's source every pass due (SOURCE_POLL_MS; a
      // refused admission comes back when it said, copy-live-engine ingestOriginal).
      const runningAt = Date.now();
      const standbyLive = (workerSide as unknown as { standbyLive?: (weight: number) => Promise<void> }).standbyLive;
      if (standbyLive) every(10_000, 0, () => standbyLive.call(workerSide, ORDER_WEIGHT + 21));
      const source = new HyperliquidLiveSourceClient('testnet', weight => liveBudget(orders, { maxWaitMs: 5_000 })(weight), workerSide.fetchInfo, Date.now,
        weight => { if (weight > 0) orders.adjust(-weight); });
      // The leader opens BTC FILL_AFTER_RUNNING_MS after the setup is running (the gate: ~74 s).
      const fillAt = runningAt + FILL_AFTER_RUNNING_MS, deadline = fillAt + SIGNAL_AGE_MS;
      const signal = { refused: [] as string[], reads: 0, readAt: undefined as number | undefined };
      let from = runningAt - 60_000, tokensAtFill: number | undefined;
      loops.push((async () => {
        while (!stop.signal.aborted && signal.readAt === undefined && Date.now() < deadline) {
          const to = Date.now() - 1_000;
          if (tokensAtFill === undefined && Date.now() >= fillAt) tokensAtFill = Math.round(orders.introspect().tokensAvailable);
          try {
            await source.read({ leaderAddress: LEADER, from, to, maxRequests: 8 }); signal.reads++;
            if (to >= fillAt) { signal.readAt = Date.now(); break; }
            from = to + 1;
            await wait(SOURCE_POLL_MS, undefined, { signal: stop.signal }).catch(() => undefined);
          } catch (error) {
            signal.refused.push(errorCode(error) ?? 'unknown');
            await wait(error instanceof HyperliquidBudgetWait ? Math.max(1_000, error.retryMs) : SOURCE_POLL_MS, undefined, { signal: stop.signal }).catch(() => undefined);
          }
        }
      })());
      while (signal.readAt === undefined && Date.now() < deadline) await wait(250);

      // The order, as live-execution-runtime runs it, retried as the engine retries it.
      const order = { attempts: [] as { reason: string; elapsedMs: number }[], connectsRefused: 0, evidenceWaitMs: 0, claimWaitMs: 0, sentAt: undefined as number | undefined };
      while (signal.readAt !== undefined && order.sentAt === undefined && Date.now() < deadline) {
        const attemptAt = Date.now();
        try {
          // Its evidence from the order bucket before its locks, within the signal.
          await liveBudget(orders, { maxWaitMs: Math.max(0, Math.min(orders.refillMs(), deadline - Date.now())) })(ORDER_WEIGHT);
          order.evidenceWaitMs = Math.max(order.evidenceWaitMs, Date.now() - attemptAt);
          const claimAt = Date.now(), token = await workerSide.claimLive(ORDER_WEIGHT, deadline);
          order.claimWaitMs = Math.max(order.claimWaitMs, Date.now() - claimAt);
          const run = async () => {
            const quota = workerSide.currentQuota();
            // The follower's and the leader's account observations: three live sockets each.
            for (let i = 0; i < 6; i++) {
              try { await (await quota.reserveSocket(Date.now() + 5000, 'testnet')).connection.cancelBeforeConnect(); }
              catch (error) { order.connectsRefused++; throw unavailable(error); }
            }
            (await quota.acquireRest(ORDER_WEIGHT - 1, Date.now() + 5000, 'live')).dispatch(() => undefined);
            (await workerSide.acquireExchange(Date.now() + 5000)).dispatch(() => { order.sentAt = Date.now(); });
          };
          await (token ? workerSide.runLive(token, run) : run());
        } catch (error) {
          const reason = errorCode(error) ?? 'unknown';
          order.attempts.push({ reason, elapsedMs: Date.now() - attemptAt });
          await wait(Math.max(250, retryDelayMs(error, reason)));
        }
      }
      stop.abort(); await Promise.allSettled(loops);
      const report = { setupMs, stages: rows.rows.stages, tokensAtFill, standby: Boolean(standbyLive), signal: { ...signal, readMs: signal.readAt === undefined ? null : signal.readAt - fillAt },
        order: { ...order, sentMs: order.sentAt === undefined ? null : order.sentAt - fillAt, afterSignalMs: order.sentAt === undefined || signal.readAt === undefined ? null : order.sentAt - signal.readAt },
        observers, harness, peak };
      console.log(JSON.stringify(report, null, 1));
      if (process.env.STARVATION_RECORD) writeFileSync(process.env.STARVATION_RECORD, JSON.stringify(report, null, 1));

      // The leader's source read is never refused behind the setup's steps:
      // the fill is read on the first pass after it.
      expect(signal.refused).toEqual([]);
      expect(signal.readAt).toBeDefined();
      expect(signal.readAt! - fillAt).toBeLessThan(SOURCE_POLL_MS + 5_000);
      // The order goes out within the SLA of its signal, never refused a socket connect.
      expect(order.connectsRefused).toBe(0);
      expect(order.attempts).toEqual([]);
      expect(order.sentAt).toBeDefined();
      expect(order.sentAt! - signal.readAt!).toBeLessThan(ORDER_SLA_MS);
      expect(peak).toBeLessThanOrEqual(1200);
    } finally {
      stop.abort();
      await Promise.allSettled(loops);
      for (const budget of new Set([main, wallet.budget, (wallet as Partial<WalletNetworkHyperliquid>).setupBudget])) budget?.onModuleDestroy();
      restore();
      await db.delete(schema.hyperliquidWsLeases).where(eq(schema.hyperliquidWsLeases.egressKey, egressKey));
      await db.delete(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey));
      await pool.end();
    }
  });
});
