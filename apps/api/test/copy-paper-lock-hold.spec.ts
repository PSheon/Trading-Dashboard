import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@trading-dashboard/shared/database';
import { copyConsumerCheckpoints, copyOrders, copySignalLegs, copySignalOutbox, copyStrategies, copyStrategyVersions } from '@trading-dashboard/shared/database';
import { CopyRepository } from '../src/copy/copy.repository.js';
import { CopyRiskPolicyService } from '../src/copy/copy-risk-policy.service.js';
import { CopyOrderPlanner } from '../src/copy/copy-planner.service.js';
import { CopySignalService } from '../src/copy/copy-signal.service.js';
import { AssetMap, type CopyMarketService, type LeaderEquity } from '../src/copy/copy-market.service.js';
import { FillSyncRepository } from '../src/watcher/fill-sync.repository.js';
import type { HlUserFill } from '../src/hyperliquid/types.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { Dec } from '../src/common/decimal/dec.js';
import { LIVE_RISK_LOCK_POLL_MS, LIVE_RISK_LOCK_WAIT_MS } from '../src/config/constants/timings.js';
import { PAPER_SIGNAL_GROUPS_PER_LOCK_LIMIT, PAPER_SIGNAL_LOCK_STATEMENT_BUDGET } from '../src/config/constants/limits.js';
import { testConfig } from './config-test-utils.js';
import { closeTestDb, getTestDb, insertUser, truncateAll, type TestDb } from './db-test-utils.js';

/**
 * H-R5 (gate 12, 2026-10-17): the paper signal drain held an owner's copy user lock (7404) for
 * 12.6–12.9 s per 200-row pass: one transaction per leader covered every owner's strategies and
 * every row, one statement at a time against a database 8 ms away. A live order of that owner
 * waits LIVE_RISK_LOCK_WAIT_MS (1 s) for the same lock and then fails live_risk_busy.
 *
 * The drain's connection here adds STATEMENT_MS before every statement (the round trip the
 * test database does not have), records each 7404 hold's statements and wall time from the
 * lock statement to its commit, and a second connection samples pg_locks/pg_stat_activity as
 * the gate's sampler did (unit: ms of transaction age while the lock is granted).
 */
const STATEMENT_MS = 5;
/** What the live path can tolerate: a hold plus one poll's gap inside its wait. */
const MAX_HOLD_MS = LIVE_RISK_LOCK_WAIT_MS / 2;
const LEADER = `0x${'1e'.repeat(20)}`;

type Hold = { userId: number; lockedAt: number; releasedAt: number; statements: number; alsoLocked: number[] };
const holds: Hold[] = [];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Instruments a pooled connection: latency before each statement, and the 7404 holds it makes. */
function instrument(client: PoolClient): void {
  const send = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
  let open: Hold | null = null;
  (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
    await delay(STATEMENT_MS);
    const first = args[0];
    const text = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
    const values = (Array.isArray(args[1]) ? args[1] : (first as { values?: unknown[] })?.values) ?? [];
    if (open) open.statements += 1;
    const result = await send(...args);
    if (/pg_advisory_xact_lock\(7404/.test(text)) {
      const userId = Number(values[0]);
      if (open) open.alsoLocked.push(userId);
      else { open = { userId, lockedAt: Date.now(), releasedAt: NaN, statements: 0, alsoLocked: [] }; holds.push(open); }
    }
    if (open && /^\s*(commit|rollback)\b/i.test(text)) { open.releasedAt = Date.now(); open = null; }
    return result;
  };
}

/** The gate's read-only sampler: how long each granted 7404 lock's transaction has run. */
class LockSampler {
  readonly maxXactMs = new Map<number, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inflight: Promise<void> = Promise.resolve();
  constructor(private readonly pool: Pool) {}
  start(): void {
    this.timer = setInterval(() => { this.inflight = this.inflight.then(() => this.sample()); }, 10);
  }
  async stop(): Promise<void> { clearInterval(this.timer); await this.inflight; await this.sample(); }
  private async sample(): Promise<void> {
    const r = await this.pool.query<{ user_id: string; xact_ms: string | null }>(
      `select l.objid::bigint as user_id, (extract(epoch from clock_timestamp() - a.xact_start) * 1000)::bigint as xact_ms
       from pg_locks l join pg_stat_activity a on a.pid = l.pid
       where l.locktype = 'advisory' and l.granted and l.classid::bigint = 7404 and l.objsubid = 2 and l.mode = 'ExclusiveLock'
         and l.database = (select oid from pg_database where datname = current_database())`);
    for (const row of r.rows) {
      const userId = Number(row.user_id), ms = Number(row.xact_ms ?? 0);
      if (ms > (this.maxXactMs.get(userId) ?? -1)) this.maxXactMs.set(userId, ms);
    }
  }
}

let db: TestDb, slowPool: Pool, samplerPool: Pool, repository: CopyRepository, uow: UnitOfWork, signals: CopySignalService;
let alice: number, bob: number, aliceStrategy: number, bobStrategy: number;
let tidSeq = 0;
const settings = { direction: 'same' as const, sizingMode: 'ratio' as const, perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: null, copyStartMode: 'delta' as const };
/** The leader's capital (ratio sizing denominator); the test can slow this read down. */
const provider = { leaderEquityDelayMs: 0, reads: [] as { from: number; to: number }[] };
const market = {
  midPrices: async () => ({ at: new Date(), px: new Map([['BTC', Dec.from(100_000)]]), missingDexes: new Set<string>() }),
  assetInfo: async () => new AssetMap([['BTC', { szDecimals: 5, maxLeverage: 40, markPx: Dec.from(100_000), funding: Dec.from('0.0001') }]]),
  leaderEquity: async (): Promise<LeaderEquity> => {
    const from = Date.now();
    await delay(provider.leaderEquityDelayMs);
    provider.reads.push({ from, to: Date.now() });
    return { state: 'known', value: Dec.from(10_000) };
  },
} as unknown as CopyMarketService;

function fill(o: { side: 'B' | 'A'; sz: number; px: number; start: number; time: number }): HlUserFill {
  const tid = ++tidSeq;
  return {
    coin: 'BTC', px: String(o.px), sz: String(o.sz), side: o.side, time: o.time, startPosition: String(o.start), dir: o.side === 'B' ? 'Open Long' : 'Close Long', closedPnl: '0',
    hash: `0x${tid.toString(16).padStart(64, '0')}`, oid: tid, crossed: true, fee: '0', tid,
  } as HlUserFill;
}

const store = (fills: HlUserFill[]) => new FillSyncRepository(db, testConfig()).insertFills(LEADER, fills);
/** `n` fills 100 ms apart, the last one just now. */
const times = (n: number) => { const now = Date.now(); return Array.from({ length: n }, (_, i) => now - (n - i) * 100); };
/** `n` buys of `sz` BTC at 100,000: one leader TWAP, one order group. */
const twap = (n: number, sz = 0.001) => times(n).map((time, i) => fill({ side: 'B', sz, px: 100_000, start: i * sz, time }));
/** `n` round trips (buy 0.01 to open, sell 0.01 to close): 2n order groups. */
const roundTrips = (n: number) => times(2 * n).map((time, i) => fill({ side: i % 2 ? 'A' : 'B', sz: 0.01, px: 100_000, start: i % 2 ? 0.01 : 0, time }));

async function drainSampled(): Promise<LockSampler> {
  holds.length = 0;
  provider.reads.length = 0;
  const sampler = new LockSampler(samplerPool);
  sampler.start();
  try { await signals.drain(); } finally { await sampler.stop(); }
  return sampler;
}

const show = (h: Hold) => `user ${h.userId}: ${h.statements} statements, ${h.releasedAt - h.lockedAt} ms`;

/** The hold assertions every pass must meet, and the record (as the gate's sampler reports it). */
function expectBoundedHolds(sampler: LockSampler, holdsPerOwner: number): void {
  process.stdout.write(`H-R5 holds at ${STATEMENT_MS} ms a statement: ${holds.map(show).join('; ')}; sampled max (ms): ${[...sampler.maxXactMs].map(([u, ms]) => `user ${u} ${ms}`).join(', ')}\n`);
  expect(holds.length, 'an owner was locked').toBeGreaterThanOrEqual(1);
  expect(holds.every((h) => Number.isFinite(h.releasedAt)), 'every hold ended with its transaction').toBe(true);
  // Before the fix: one hold of alice's lock covered bob's strategy too (alsoLocked = [bob]),
  // every fill of both, hundreds of statements and seconds at 5 ms a statement.
  const worstStatements = Math.max(...holds.map((h) => h.statements));
  const worstMs = Math.max(...holds.map((h) => h.releasedAt - h.lockedAt));
  expect(worstStatements, `statements under one hold: ${holds.map(show).join('; ')}`).toBeLessThanOrEqual(PAPER_SIGNAL_LOCK_STATEMENT_BUDGET);
  expect(worstMs, `wall time under one hold (ms): ${holds.map(show).join('; ')}`).toBeLessThan(MAX_HOLD_MS);
  expect(holds.flatMap((h) => h.alsoLocked), 'a locked transaction locks one owner only').toEqual([]);
  // The sampler's view of the same holds (unit: ms of transaction age with the lock granted).
  const byId = (a: number, b: number) => a - b;
  expect([...sampler.maxXactMs.keys()].sort(byId)).toEqual([alice, bob].sort(byId));
  for (const [userId, ms] of sampler.maxXactMs) expect(ms, `sampled hold of user ${userId} (ms)`).toBeLessThan(MAX_HOLD_MS);
  // Between two holds of one owner, at least one live poll interval passes (timer slop aside).
  for (const userId of [alice, bob]) {
    const mine = holds.filter((h) => h.userId === userId).sort((a, b) => a.lockedAt - b.lockedAt);
    expect(mine.length, `holds of user ${userId}`).toBe(holdsPerOwner);
    for (let i = 1; i < mine.length; i++) expect(mine[i]!.lockedAt - mine[i - 1]!.releasedAt, `gap before hold ${i} of user ${userId} (ms)`).toBeGreaterThanOrEqual(LIVE_RISK_LOCK_POLL_MS - 10);
  }
}

async function expectAllDone(fills: number): Promise<void> {
  const rows = await db.select().from(copySignalOutbox);
  expect(rows).toHaveLength(fills);
  expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['done']));
  const [checkpoint] = await db.select().from(copyConsumerCheckpoints);
  expect(checkpoint).toMatchObject({ processed: fills, lastOutboxId: rows.reduce((m, r) => (r.id > m ? r.id : m), 0n) });
}

beforeAll(() => {
  db = getTestDb();
  slowPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  slowPool.on('connect', instrument);
  samplerPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  const slowDb = drizzle(slowPool, { schema });
  repository = new CopyRepository(slowDb);
  uow = new UnitOfWork(slowDb);
  const policies = new CopyRiskPolicyService(repository, uow, market, null as never);
  signals = new CopySignalService(repository, uow, market, new CopyOrderPlanner(repository), policies);
});
beforeEach(async () => {
  await truncateAll(db);
  provider.leaderEquityDelayMs = 0;
  alice = (await insertUser(db, { privyUserId: 'did:privy:alice-lock' })).id;
  bob = (await insertUser(db, { privyUserId: 'did:privy:bob-lock' })).id;
  // Bob's strategy has the lower id; owners are still taken in ascending user order.
  bobStrategy = (await db.insert(copyStrategies).values({ userId: bob, leaderAddress: LEADER, allocated: '1000', cash: '1000', activatedAt: new Date(0) }).returning())[0]!.id;
  aliceStrategy = (await db.insert(copyStrategies).values({ userId: alice, leaderAddress: LEADER, allocated: '1000', cash: '1000', activatedAt: new Date(0) }).returning())[0]!.id;
  for (const strategyId of [aliceStrategy, bobStrategy]) await db.insert(copyStrategyVersions).values({ strategyId, version: 1, settings, createdByUserId: strategyId === aliceStrategy ? alice : bob });
});
afterAll(async () => { await slowPool.end(); await samplerPool.end(); await closeTestDb(); });

describe('the paper signal drain and the copy user lock (H-R5)', () => {
  it('a 48-fill TWAP of two owners: one order per strategy, one hold per owner within the statement budget, never the other owner\'s lock', { timeout: 60_000 }, async () => {
    const fills = 48;
    await store(twap(fills));
    const sampler = await drainSampled();
    expectBoundedHolds(sampler, 1);

    // Same outcome rows as before: every leg ordered, ONE order per strategy for the leader's 0.048 BTC.
    for (const strategyId of [aliceStrategy, bobStrategy]) {
      const legs = await db.select().from(copySignalLegs).where(eq(copySignalLegs.strategyId, strategyId));
      expect(legs).toHaveLength(fills);
      expect(new Set(legs.map((l) => l.outcome))).toEqual(new Set(['ordered']));
      const orders = await db.select().from(copyOrders).where(eq(copyOrders.strategyId, strategyId));
      // Ratio sizing on 1,000 of the leader's 10,000: a tenth of 0.048.
      expect(orders.map((o) => [o.leg, o.status, o.size])).toEqual([['open', 'risk_approved', '0.0048']]);
      expect(orders[0]!.signalTids).toHaveLength(fills);
    }
    await expectAllDone(fills);
  });

  it('six order groups (three round trips) of two owners: the budget splits them over paced holds, each within the budget; orders as before', { timeout: 60_000 }, async () => {
    const groups = 6;
    await store(roundTrips(groups / 2));
    const sampler = await drainSampled();
    expectBoundedHolds(sampler, Math.ceil(groups / PAPER_SIGNAL_GROUPS_PER_LOCK_LIMIT));

    for (const strategyId of [aliceStrategy, bobStrategy]) {
      const legs = await db.select().from(copySignalLegs).where(eq(copySignalLegs.strategyId, strategyId));
      expect(legs).toHaveLength(groups);
      expect(new Set(legs.map((l) => l.outcome))).toEqual(new Set(['ordered']));
      const orders = await db.select().from(copyOrders).where(eq(copyOrders.strategyId, strategyId)).orderBy(asc(copyOrders.id));
      expect(orders.map((o) => [o.leg, o.side, o.status, o.size])).toEqual([
        ['open', 'B', 'risk_approved', '0.001'], ['close', 'A', 'risk_approved', '0.001'],
        ['open', 'B', 'risk_approved', '0.001'], ['close', 'A', 'risk_approved', '0.001'],
        ['open', 'B', 'risk_approved', '0.001'], ['close', 'A', 'risk_approved', '0.001'],
      ]);
    }
    await expectAllDone(groups);
  });

  it('a slow provider read (the leader\'s equity, 1 s) completes before any owner lock is taken', { timeout: 30_000 }, async () => {
    provider.leaderEquityDelayMs = 1_000;
    await store(twap(1, 0.01));
    const sampler = await drainSampled();
    expect(provider.reads).toHaveLength(1);
    const read = provider.reads[0]!;
    // A 1 s setTimeout may fire a millisecond early (CI run 39016923638 saw 999): the read's own
    // duration only has to be the delay within timer precision; the lock-after-read assertion below is exact.
    expect(read.to - read.from).toBeGreaterThanOrEqual(1_000 - 10);
    expect(holds.length).toBe(2);
    for (const h of holds) {
      expect(h.lockedAt, 'the lock is taken after the read resolved').toBeGreaterThanOrEqual(read.to);
      expect(h.releasedAt - h.lockedAt).toBeLessThan(MAX_HOLD_MS);
    }
    for (const [userId, ms] of sampler.maxXactMs) expect(ms, `sampled hold of user ${userId} (ms)`).toBeLessThan(MAX_HOLD_MS);
    expect((await db.select().from(copyOrders)).map((o) => o.size).sort()).toEqual(['0.001', '0.001']);
  });
});
