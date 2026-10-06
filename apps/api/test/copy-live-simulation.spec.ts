import { appendFileSync } from 'node:fs';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import * as schema from '@trading-dashboard/shared/database';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../src/config/app-config.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import type { HlUserFill } from '../src/hyperliquid/types.js';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import { digest as mandateDigest } from '../src/copy/copy-live-mandate-evidence.js';
import { CopyLiveSourceRepository } from '../src/copy/copy-live-source.repository.js';
import { liveSourceExecutionCloid } from '../src/copy/live/postgres-live-preparation.js';
import type { LiveExecutionRecord } from '../src/copy/live/live-execution.js';
import { CopyLiveEngine } from '../src/copy/live-worker/copy-live-engine.js';
import { CopyLiveWorkerRepository } from '../src/copy/live-worker/copy-live-worker.repository.js';
import { CopyLiveWorkerService } from '../src/copy/live-worker/copy-live-worker.service.js';
import { FastMainnetSource } from '../src/copy/live-worker/fast-mainnet-source.js';
import { WatchedMainnetSource } from '../src/copy/live-worker/watched-mainnet-source.js';
import { preparationFixture } from './copy-live-preparation-test-utils.js';
import { testConfig } from './config-test-utils.js';
import { now as T0 } from './copy-live-risk-test-utils.js';
import { closeTestDb, getTestDb, type TestDb } from './db-test-utils.js';

/*
 * The measured leader pattern (2026-10-06, 0xe799…: ~2.3 orders a minute,
 * ~1.5 fills an order, almost all adds to shorts, 4 coins, ~84 USDC an
 * order on a 23.6k account) replayed through the real engine, worker
 * service (kick scheduling), fast source, merging and real testnet
 * RequestBudgeterService, in virtual time. Only the exchange is a fake:
 * an order's evidence takes its measured weight and time (the REST wave
 * ~0.1 s, the all-dex account socket ~3.5 s, measured on testnet), the POST
 * 0.2 s; its settlement its weight and 1 s. Index lag follows the mainnet
 * probe (most fills visible within 0.6 s, a few after 3-6 s).
 */
const LEADER = `0x${'44'.repeat(20)}`, G = 2000, LEADER_EQUITY = '23600';
const COINS = [{ coin: 'SOL', px: 200, p: 0.45 }, { coin: 'HYPE', px: 40, p: 0.35 }, { coin: 'BTC', px: 120000, p: 0.1 }, { coin: 'MON', px: 0.05, p: 0.1 }];
interface Scenario { budgetUsd: string; weightPerMin: number; evidenceMs: number; evidenceWeight: (otherCoins: number) => number; settleWeight: number; minutes: number;
  /** Mean seconds between the leader's orders (26: the measured ~2.3 a minute). */
  orderEverySeconds?: number }

let db: TestDb;
let inflight = 0;
/** Lets real database I/O finish before virtual time moves on. */
async function quiet() {
  for (let i = 0, calm = 0; i < 200_000 && calm < 8; i++) { await new Promise(resolve => setImmediate(resolve)); calm = inflight === 0 ? calm + 1 : 0; }
}
function random(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const fmt = (value: number) => value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
/** SIM_OUT=<file> keeps each scenario's figures (vitest hides a passing test's output). */
const report = (name: string, result: unknown) => { console.log(`SIMULATION ${name}`, JSON.stringify(result)); if (process.env.SIM_OUT) appendFileSync(process.env.SIM_OUT, `${name} ${JSON.stringify(result)}\n`); };
const pct = (values: number[], p: number) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! : null; };

async function simulate(scenario: Scenario) {
  const seed = await preparationFixture(db, 'ratio');
  const consent = { ...seed.consent, sourceNetwork: 'mainnet' as const };
  await db.update(schema.copyLiveStrategyConfigs).set({ sourceNetwork: 'mainnet', budgetUsd: scenario.budgetUsd });
  await db.update(schema.copyLiveMandates).set({ sourceNetwork: 'mainnet', intent: consent, intentDigest: mandateDigest(consent), expiresAt: new Date(T0 + 7 * 86_400_000) });
  await db.delete(schema.copyLiveSourceFills); await db.delete(schema.copyLiveSourceStreams);
  await db.insert(schema.copyLiveActivations).values({ mandateId: 'mandate', userId: 1, strategyId: 9, accountId: 'account', state: 'activated', controlRevision: 0, requestedAt: new Date(T0 - 3000), activatedAt: new Date(T0 - 2000) });
  vi.useFakeTimers({ now: T0, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const base = testConfig().value;
  const budget = new RequestBudgeterService(new AppConfig({ ...base, hyperliquid: { ...base.hyperliquid, budgetPerMin: scenario.weightPerMin, burst: 1200 - scenario.weightPerMin, startupPaceSeconds: 0 } } as never));
  let acquired = 0, orders = 0;
  const acquire = async (weight: number) => { acquired += weight; await budget.acquire(weight, 'live'); };
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const opened = new Set<string>(), errors: string[] = [];
  // The leader on mainnet: fills become visible to REST after their index lag.
  const rest: { fill: HlUserFill; visibleAt: number }[] = [];
  const reader = { fills: async (_leader: string, from: number) => ({ fills: rest.filter(r => r.fill.time >= from && r.visibleAt <= Date.now()).map(r => r.fill), sentAt: Date.now() }),
    twapSlices: async () => [] as HlUserFill[] };
  const fast = new FastMainnetSource(reader, G, Date.now);
  const engine = new CopyLiveEngine({
    network: 'testnet', repository: new CopyLiveWorkerRepository(db, new UnitOfWork(db), testConfig()), sources: new CopyLiveSourceRepository(db), uow: new UnitOfWork(db),
    watched: new WatchedMainnetSource(db), testnetSource: { read: async () => { throw new Error('unused'); } } as never,
    runtime: hooks => ({ execute: async request => {
      const coin = (await db.select({ coin: schema.copyLiveSourceFills.coin }).from(schema.copyLiveSourceFills).where(eq(schema.copyLiveSourceFills.id, request.sourceFillId)))[0]!.coin;
      await acquire(scenario.evidenceWeight([...opened].filter(c => c !== coin).length));
      await sleep(scenario.evidenceMs);
      hooks.onExchange?.({ phase: 'request', at: Date.now() }); await sleep(200); hooks.onExchange?.({ phase: 'response', at: Date.now() });
      const key = `testnet:${seed.f.identity.accountAddress}:${liveSourceExecutionCloid(request.mandateId, request.sourceFillId, request.leg)}`;
      await db.insert(schema.copyLiveExecutions).values({ key, network: 'testnet', accountAddress: seed.f.identity.accountAddress, signerAddress: `0x${'33'.repeat(20)}`,
        cloid: key.split(':').at(-1)!, nonce: Date.now() + orders, userId: 1, strategyId: 9, state: 'filled', record: { key }, updatedAt: new Date() });
      orders++; if (request.leg === 'open') opened.add(coin);
      return { key, state: 'filled' } as LiveExecutionRecord;
    } }),
    settler: { settle: async () => { await acquire(scenario.settleWeight); await sleep(1000); return { kind: 'released' }; } },
    fast: { source: fast, leaders: new Set([LEADER]), feedUp: () => true },
    leaderEquity: async () => LEADER_EQUITY,
    log: message => { if (errors.length < 10) errors.push(`${Date.now() - T0} ${message}`); },
  });
  const service = new CopyLiveWorkerService({ value: { ...base, copy: { mode: 'testnet', workerIntervalMs: 2000 } } } as never, new BackgroundJobs(), engine);
  service.start(3000);
  // The leader's orders, as measured.
  const rand = random(7), end = T0 + scenario.minutes * 60_000, position = new Map<string, number>();
  let t = T0 + 5000, tid = 1, oid = 1;
  while (t < end - 60_000) {
    const pick = rand(), spec = COINS.find((_, i) => pick < COINS.slice(0, i + 1).reduce((s, c) => s + c.p, 0)) ?? COINS[0]!;
    const held = position.get(spec.coin) ?? 0, reduce = held < 0 && rand() < 0.08;
    const total = reduce ? -held * 0.3 : (84 / spec.px) * (0.8 + 0.4 * rand()), parts = rand() < 0.4 ? 2 : 1;
    let start = held; oid++;
    for (let i = 0; i < parts; i++) {
      const sz = total / parts, time = t + i * 50, side = reduce ? 'B' : 'A';
      const fill = { coin: spec.coin, px: fmt(spec.px), sz: fmt(sz), side, time, startPosition: fmt(start), dir: reduce ? 'Close Short' : 'Open Short', closedPnl: '0',
        hash: `0x${'12'.repeat(32)}`, oid, crossed: true, fee: '0.01', tid: tid++, feeToken: 'USDC' } as unknown as HlUserFill;
      start = reduce ? start + sz : start - sz;
      const lag = Math.round(rand() < 0.05 ? 3000 + 3000 * rand() : 150 + 400 * rand());
      rest.push({ fill, visibleAt: time + lag });
      setTimeout(() => service.onLeaderTraded({ address: LEADER, time, tid: fill.tid }), time + 150 - T0);
    }
    position.set(spec.coin, start);
    t += Math.round(-Math.log(1 - rand()) * (scenario.orderEverySeconds ?? 26) * 1000); // ~2.3 orders a minute as measured
  }
  const leaderOrders = oid - 1, leaderFills = tid - 1;
  while (Date.now() < end) { await quiet(); await vi.advanceTimersToNextTimerAsync(); }
  await quiet(); service.onModuleDestroy(); vi.useRealTimers();
  const rows = await db.select().from(schema.copyLiveDispatches);
  const sent = rows.filter(r => r.sentAt), refusals: Record<string, number> = {};
  for (const r of rows.filter(r => r.state === 'refused')) refusals[r.reason!] = (refusals[r.reason!] ?? 0) + 1;
  const sentLatency = sent.map(r => r.sentAt!.getTime() - r.leaderTime.getTime()), signal = rows.map(r => r.receivedAt.getTime() - r.leaderTime.getTime());
  const mergedLegs = rows.filter(r => r.reason === 'merged_into_adjustment').length;
  return { leaderOrders, leaderFills, legs: rows.length, orders: sent.length, mergedLegs, ordersPerMin: sent.length / (scenario.minutes - 1),
    signal: { p50: pct(signal, 0.5), p95: pct(signal, 0.95) }, sent: { p50: pct(sentLatency, 0.5), p95: pct(sentLatency, 0.95), max: pct(sentLatency, 1) },
    weightPerOrder: sent.length ? Math.round(acquired / sent.length) : null, refusals, fastWeightPerMin: Math.round(fast.stats(LEADER).weight / scenario.minutes), errors,
    slow: sent.filter(r => r.sentAt!.getTime() - r.leaderTime.getTime() > 10_000).map(r => ({ leg: r.leg, coin: r.coin, ms: r.sentAt!.getTime() - r.leaderTime.getTime(), attempts: r.attempts, merged: r.adjustmentId !== null })),
    sourceFills: (await db.select().from(schema.copyLiveSourceFills)).length };
}

describe('copy simulation: the measured leader through the engine (virtual time, real budgeters)', () => {
  const originalPool = pg.Pool.prototype.query, originalClient = pg.Client.prototype.query;
  const counted = (original: (...args: unknown[]) => unknown) => function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args) as Promise<unknown> | undefined;
    if (result && typeof result.then === 'function') { inflight++; void result.then(() => { inflight--; }, () => { inflight--; }); }
    return result;
  };
  pg.Pool.prototype.query = counted(originalPool as never) as never; pg.Client.prototype.query = counted(originalClient as never) as never;
  afterEach(() => { vi.useRealTimers(); });
  afterAll(async () => { pg.Pool.prototype.query = originalPool; pg.Client.prototype.query = originalClient; await closeTestDb(); });
  db = getTestDb();

  // After P1 + P2: an order's evidence 385 + 20 per other open coin, its settlement ~351, at 700/min.
  const after = (budgetUsd: string, extra: Partial<Scenario> = {}): Scenario => ({ budgetUsd, weightPerMin: 700, evidenceMs: 3600,
    evidenceWeight: k => 385 + 20 * k, settleWeight: 351, minutes: 31, ...extra });

  it('the measured pace, 5,000 USDC copy: signals in ~2 s; orders bounded by the testnet weight', async () => {
    const result = await simulate(after('5000'));
    report('measured pace, 5000 USDC', result);
    expect(result.signal.p50!).toBeLessThanOrEqual(3000); expect(result.signal.p95!).toBeLessThanOrEqual(6000);
    expect(result.mergedLegs).toBeGreaterThan(0);
    // ~1.5 orders a minute fit 700/min; the rest of the leader's ~2.1 wait and merge, and a few expire (see the report).
    expect(result.ordersPerMin).toBeGreaterThanOrEqual(1);
  }, 600_000);

  it('a leader at 0.5 orders a minute, 5,000 USDC copy: nothing expires; sent latency as the account socket allows', async () => {
    const today = await simulate(after('5000', { orderEverySeconds: 120 }));
    const p3 = await simulate(after('5000', { orderEverySeconds: 120, evidenceMs: 500 }));
    report('0.5/min, 5000 USDC', today);
    report('0.5/min, 5000 USDC, socket read narrowed (P3)', p3);
    for (const result of [today, p3]) expect(result.refusals.signal_expired ?? 0).toBe(0);
    // The median order goes in ~5.7 s today (the all-dex account socket ~3.5 s) and ~2.6 s with it narrowed;
    // the tail waits for testnet weight: an order and its settlement (~756) exceed the 500 burst.
    expect(today.sent.p50!).toBeLessThanOrEqual(6000); expect(p3.sent.p50!).toBeLessThanOrEqual(5000);
  }, 600_000);

  it('the measured pace, 100 USDC copy: each add is ~0.36 USDC; held, never sent, none expires as a signal', async () => {
    const result = await simulate(after('100'));
    report('measured pace, 100 USDC', result);
    expect(result.refusals.signal_expired ?? 0).toBe(0); expect(result.orders).toBe(0);
  }, 600_000);
});
