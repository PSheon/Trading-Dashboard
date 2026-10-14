import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';
import pg from 'pg';
import WebSocket from 'ws';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '@trading-dashboard/shared/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- the harness's plain ESM helper (no declarations)
import { installDbRtt } from '../../../scripts/copy-harness/db-rtt.mjs';
import { renderReport } from '../../../scripts/copy-harness/mainnet-evidence-probe.mjs';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { HyperliquidGlobalTransport, settleListAnswer } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { infoListSurcharge, infoWeight } from '../src/hyperliquid/info-weights.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { HyperliquidAllDexsAccountSource, PerReadAllDexsAccountSource } from '../src/copy/live/live-account-ws-source.js';
import { HyperliquidLiveAccountObserver } from '../src/copy/live/live-account-observer.js';
import { HyperliquidLiveMarketResolver } from '../src/copy/live/live-market-resolver.js';
import { HyperliquidLiveRiskProvider } from '../src/copy/live/live-risk-provider.js';
import { LiveProviderReadEpoch } from '../src/copy/live/live-provider-read-epoch.js';
import { originalLiveInfoBatch } from '../src/copy/live/live-execution-runtime.js';
import { liveReadCache } from '../src/copy/live/live-read-cache.js';
import { liveEvidenceWeight } from '../src/copy/live/live-shared-reads.js';
import { LiveSpanRecorder, type LiveExecutionTiming } from '../src/copy/live/live-execution-diagnostics.js';
import { LIVE_ORDER_BOUNDARY_WEIGHT } from '../src/config/constants/weights.js';

/**
 * Manual probe, NEVER in CI (the e2e config, and HL_MAINNET_PROBE=1 required):
 * an order's evidence collection on Hyperliquid MAINNET, read-only, and the
 * mainnet fill index lag. Run it through
 *   node scripts/copy-harness/mainnet-evidence-probe.mjs run --runner <local-db-test.sh>
 * (an isolated, migrated local database; the report is printed at the end).
 *
 * What runs is the order path's real provider epoch, as LiveExecutionRuntime
 * composes it: a live-lane claim (claimLive / runLive) before an original
 * PostgresLiveRiskScope session (its advisory locks), on which
 * LiveProviderReadEpoch.collect runs with the shared reads (each wave one
 * batch through HyperliquidGlobalTransport.fetchInfoBatch, charged to the
 * PostgresHyperliquidQuota meter on the original session), the account
 * observer for the follower and the leader (each its own
 * HyperliquidAllDexsAccountSource socket, its connect and subscriptions
 * charged to the same meter), the market resolver and the risk provider;
 * every SQL statement waits COPY_HARNESS_DB_RTT_MS first (db-rtt.mjs, as the
 * stage-like profile). Only the SQL authority's content is a double (the
 * order's account and its leader: loadLivePreparationAuthority below; its read
 * is still a statement and a lock check on the original session). The local
 * budget (`acquire`) is a no-op: the runtime prepays it before the SQL locks.
 *
 * Read-only by construction: the transport's fetch refuses anything but a
 * POST to the mainnet info endpoint, the socket factory anything but the
 * mainnet WS endpoint and subscribe / unsubscribe / ping commands. Nothing
 * here can sign, reach /exchange or move funds.
 *
 *   HL_MAINNET_PROBE=1         required
 *   COPY_HARNESS_DB_RTT_MS=8   round trip added to every SQL statement (default 8)
 *   HL_PROBE_FOLLOWER / HL_PROBE_LEADER / HL_PROBE_COIN   the observed accounts and the order's coin
 *   HL_PROBE_RUNS=20 / HL_PROBE_CLOSE_RUNS=0   open (ratio: leader included, leverage checked) / close epochs
 *   HL_PROBE_PACE_MS=65000     between epochs (also kept under HL_PROBE_MAX_WEIGHT_PER_MIN=600 of provider weight)
 *   HL_PROBE_EVIDENCE=0 / HL_PROBE_FILL_LAG=0   skip a part
 *   HL_PROBE_FILL_ADDRESS, HL_PROBE_FILL_LAG_MIN=10, HL_PROBE_FILL_POLL_MS=4000, HL_PROBE_FILL_WINDOW_MS=60000
 *   HL_MAINNET_PROBE_OUT       the result's JSON (scripts/copy-harness/mainnet-evidence-probe.mjs report <json>)
 */
const probe = vi.hoisted(() => ({
  // A public mainnet account an order could be placed for, as the order path
  // requires of a follower (role user, abstraction disabled, dex abstraction
  // false, no HIP-3 venue activity, no trigger orders) with a main-dex
  // position (HYPE): the candidate leader 0x2e30… is a unified account, which
  // the observer refuses as an ordering account (live_account_unsupported_abstraction).
  follower: (process.env.HL_PROBE_FOLLOWER ?? '0x13d2c8cd96bc7ecbdb8800874d20f51588b6d43c').toLowerCase(),
  leader: (process.env.HL_PROBE_LEADER ?? '0x2e30c32738a28833e3d85189c04895c25ee54cb5').toLowerCase(),
}));
vi.mock('../src/copy/live/postgres-live-risk-authority.js', async original => {
  const actual = await original<typeof import('../src/copy/live/postgres-live-risk-authority.js')>();
  return { ...actual, loadLivePreparationAuthority: async (session: { scope: { assertHeld(): Promise<void> } }, db: { execute(q: unknown): Promise<unknown> }) => {
    await db.execute(sql`select 1`); await session.scope.assertHeld();
    return { account: { id: 'account', network: 'mainnet', address: probe.follower }, accounts: [{ id: 'account', address: probe.follower }],
      consent: { leaderAddress: probe.leader }, limits: { maxLeverage: 50 }, settings: { maxLeverage: null } };
  } };
});

const env = process.env, INFO = 'https://api.hyperliquid.xyz/info', WS = 'wss://api.hyperliquid.xyz/ws';
const num = (name: string, fallback: number) => { const v = Number(env[name] ?? fallback); if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a number`); return v; };
const config = {
  follower: probe.follower, leader: probe.leader, coin: env.HL_PROBE_COIN ?? 'ETH',
  dbRttMs: num('COPY_HARNESS_DB_RTT_MS', 8), runs: num('HL_PROBE_RUNS', 20), closeRuns: num('HL_PROBE_CLOSE_RUNS', 0),
  paceMs: num('HL_PROBE_PACE_MS', 65_000), maxWeightPerMin: num('HL_PROBE_MAX_WEIGHT_PER_MIN', 600),
  egressKey: env.HYPERLIQUID_EGRESS_KEY ?? 'mainnet-evidence-probe',
  fillAddress: (env.HL_PROBE_FILL_ADDRESS ?? '0xf5d81a135f756ca16544e53c20fc20643ec3ad53').toLowerCase(),
  fillLagMin: num('HL_PROBE_FILL_LAG_MIN', 10), fillPollMs: num('HL_PROBE_FILL_POLL_MS', 4000), fillWindowMs: num('HL_PROBE_FILL_WINDOW_MS', 60_000),
};
const OUT = env.HL_MAINNET_PROBE_OUT ?? fileURLToPath(new URL(`../../../.claude/logs/copy-harness/mainnet-evidence-probe-${Date.now()}.json`, import.meta.url));

interface Sent { type: string; weight: number; status: number; ms: number; boundary?: true }
interface WsCounts { sockets: number; subscribes: number; unsubscribes: number; other: number; framesIn: number; bytesIn: number; subscriptionsByType: Record<string, number> }
const wsCounts = (): WsCounts => ({ sockets: 0, subscribes: 0, unsubscribes: 0, other: 0, framesIn: 0, bytesIn: 0, subscriptionsByType: {} });
/** The current run's requests and socket traffic, and every provider weight sent (a rolling minute). */
let sent: Sent[] = [], ws = wsCounts(), rateLimited = false, inBoundary = false;
const ledger: { at: number; weight: number }[] = [];
const recentWeight = () => { const since = Date.now() - 60_000; return ledger.filter(e => e.at > since).reduce((s, e) => s + e.weight, 0); };

/** Every REST request the probe's transport sends: the mainnet info endpoint only. */
const probeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url !== INFO || init?.method !== 'POST' || typeof init.body !== 'string') throw new Error(`mainnet probe refuses ${String(init?.method)} ${url}`);
  const type = String((JSON.parse(init.body) as { type?: unknown }).type), started = performance.now();
  const response = await fetch(url, init);
  const weight = infoWeight({ type });
  sent.push({ type, weight, status: response.status, ms: Math.round(performance.now() - started), ...(inBoundary ? { boundary: true as const } : {}) });
  ledger.push({ at: Date.now(), weight });
  if (response.status === 429) rateLimited = true;
  return response;
};
/** Every socket the account source opens: the mainnet WS endpoint, subscriptions only. */
const probeSocket = (url: string, options: WebSocket.ClientOptions): WebSocket => {
  if (url !== WS) throw new Error(`mainnet probe refuses socket ${url}`);
  const socket = new WebSocket(url, options), counts = ws;
  counts.sockets++;
  const send = socket.send.bind(socket) as (data: unknown, ...rest: unknown[]) => void;
  (socket as unknown as { send: (data: unknown, ...rest: unknown[]) => void }).send = (data, ...rest) => {
    const command = JSON.parse(String(data)) as { method?: string; subscription?: { type?: string } };
    if (command.method === 'subscribe') { counts.subscribes++; const t = String(command.subscription?.type); counts.subscriptionsByType[t] = (counts.subscriptionsByType[t] ?? 0) + 1; }
    else if (command.method === 'unsubscribe') counts.unsubscribes++;
    else if (command.method === 'ping') counts.other++;
    else throw new Error(`mainnet probe refuses WS ${String(command.method)}`);
    send(data, ...rest);
  };
  socket.on('message', (raw: WebSocket.RawData) => { counts.framesIn++; counts.bytesIn += Array.isArray(raw) ? raw.reduce((n, b) => n + b.length, 0) : raw.byteLength; });
  return socket;
};
const code = (e: unknown) => e instanceof Error ? (e as { code?: string }).code ?? e.message : String(e);
const result: Record<string, unknown> & { cases: Record<string, { runs: unknown[] }> } = {
  startedAt: new Date().toISOString(), config, cases: {}, ...(env.HL_PROBE_CLOCK_OFFSET ? { clockOffset: env.HL_PROBE_CLOCK_OFFSET } : {}),
};
const save = () => { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(result, null, 1)); };

describe.skipIf(env.HL_MAINNET_PROBE !== '1')('mainnet evidence probe (manual, read-only)', () => {
  let pool: pg.Pool, quota: PostgresHyperliquidQuota, global: HyperliquidGlobalTransport, restore = () => {};
  beforeAll(async () => {
    // Every statement of every pg client waits the round trip first (the stage-like profile).
    restore = installDbRtt(pg.Client, config.dbRttMs);
    pool = new pg.Pool({ connectionString: env.TEST_DATABASE_URL, max: 6 });
    const started = performance.now(); await pool.query('select 1');
    console.log(JSON.stringify({ event: 'probe_db_rtt', configuredMs: config.dbRttMs, measuredMs: Math.round(performance.now() - started) }));
    quota = new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema })));
    global = new HyperliquidGlobalTransport(quota, { egressKey: config.egressKey, ownerId: 'mainnet-evidence-probe' }, probeFetch);
  });
  afterAll(async () => { await pool?.end(); restore(); save(); console.log(`\n${renderReport(result)}\n\n${OUT}`); });

  /** One order's provider epoch, as LiveExecutionRuntime runs it (see the header). */
  async function epochRun(kind: 'open' | 'close', run: number) {
    sent = []; ws = wsCounts();
    const open = kind === 'open', timings: LiveExecutionTiming[] = [];
    const weight = liveEvidenceWeight([config.follower], 0, liveReadCache('mainnet'), open ? [config.leader] : []) + LIVE_ORDER_BOUNDARY_WEIGHT;
    const token = await global.claimLive(weight, Date.now() + 10_000);
    const lane = <T>(work: () => Promise<T>) => token === undefined ? work() : global.runLive(token, work);
    const recorder = new LiveSpanRecorder(), base = performance.now(), wallBase = Date.now();
    const at = () => Math.round(performance.now() - base);
    const raw: Record<string, unknown> = { run, case: kind, claimedWeight: weight, liveToken: token !== undefined };
    let error: string | undefined;
    await recorder.run(() => lane(() => new PostgresLiveRiskScope(pool, Date.now, undefined, { kind: 'order', id: `probe-${kind}-${run}` })
      .run({ userId: 1, network: 'mainnet', accountAddress: config.follower, source: { network: 'mainnet', leaderAddress: config.leader } },
        async (_scope, session) => global.runOriginal(session, async () => {
          global.currentQuota();
          const acquire = async () => {};
          const sockets = new PerReadAllDexsAccountSource(() => new HyperliquidAllDexsAccountSource(Date.now, probeSocket, 'mainnet', global), 3);
          const observer = new HyperliquidLiveAccountObserver('mainnet', acquire, global.fetchInfo, Date.now, 5000, sockets);
          const resolver = new HyperliquidLiveMarketResolver('mainnet', acquire, global.fetchInfo, Date.now);
          const provider = new HyperliquidLiveRiskProvider('mainnet', acquire, global.fetchInfo, Date.now);
          const epoch = new LiveProviderReadEpoch(observer, resolver, provider, { extraRiskBufferBps: '5', restingOrderBuilderFeeCapTenthsBps: 100 }, Date.now,
            { acquire, fetcher: global.fetchInfo, batch: originalLiveInfoBatch('mainnet', global, () => session.scope.assertFresh()), cache: liveReadCache('mainnet') },
            event => { timings.push(event); });
          raw.collectAtMs = at();
          try {
            const frames = await epoch.collect(session, { accountId: 'account', mandateId: 'mandate', key: `probe-${kind}-${run}`, coin: config.coin, leg: kind,
              includeLeader: open, checkLeverage: open }).finally(() => { raw.collectEndAtMs = at(); });
            raw.dexes = frames.snapshots[0]?.coverage.listedDexes.length;
            raw.positions = frames.snapshots[0]?.positions.length; raw.restingOrders = frames.snapshots[0]?.restingOrders.length;
            raw.otherMarkets = frames.others.length; raw.leaderPositions = frames.leader?.positions.length ?? null;
            // The exchange boundary's provider reads on the same session after
            // collect, as the signer and the transport send them (each through
            // fetchInfo, one meter request): the agent approval (extraAgents)
            // at the sign gate and again at the submit gate, the builder fee cap.
            // Read-only; the builder address is a stand-in (same request shape and weight).
            const boundaryAtMs = at(), reads: { type: string; ms: number; status: number }[] = [];
            inBoundary = true;
            try {
              for (const body of [{ type: 'extraAgents', user: config.follower }, { type: 'maxBuilderFee', user: config.follower, builder: config.leader }, { type: 'extraAgents', user: config.follower }]) {
                const started = performance.now();
                const response = await global.fetchInfo(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
                await response.arrayBuffer();
                reads.push({ type: body.type, ms: Math.round(performance.now() - started), status: response.status });
              }
            } finally { inBoundary = false; }
            raw.boundary = { atMs: boundaryAtMs, endAtMs: at(), reads };
          } catch (e) { error = code(e); }
          finally {
            raw.collectEndAtMs ??= at();
            const shared = epoch.sharedReads(session);
            try { raw.clockAtMs = shared ? shared.startedAt - wallBase : null; } catch { raw.clockAtMs = null; }
            raw.sentWeight = shared?.sentWeight; raw.paidWeight = shared?.paidWeight;
            provider.close(); sockets.close();
          }
        })))).catch((e: unknown) => { error ??= code(e); raw.collectEndAtMs ??= at(); });
    Object.assign(raw, { ok: error === undefined, ...(error ? { error } : {}), timings, spans: recorder.spans, rest: [...sent], ws: { ...ws } });
    return raw;
  }

  it.skipIf(env.HL_PROBE_EVIDENCE === '0')('collects an order\'s evidence on mainnet, repeatedly, with every span', { timeout: 120 * 60_000 }, async () => {
    const plan = [...Array.from({ length: config.runs }, (_, i) => ['open', i + 1] as const), ...Array.from({ length: config.closeRuns }, (_, i) => ['close', i + 1] as const)];
    let last = 0;
    for (const [kind, run] of plan) {
      // Paced, and well under the per-IP minute (1200) with what this probe sent.
      while (Date.now() - last < config.paceMs || recentWeight() + 500 > config.maxWeightPerMin) await wait(1000);
      last = Date.now();
      const raw = await epochRun(kind, run);
      (result.cases[kind] ??= { runs: [] }).runs.push(raw);
      save();
      console.log(JSON.stringify({ case: kind, run, ok: raw.ok, error: raw.error, collectMs: (raw.collectEndAtMs as number) - (raw.collectAtMs as number),
        ageMs: raw.clockAtMs === null ? null : (raw.collectEndAtMs as number) - (raw.clockAtMs as number), rest: (raw.rest as Sent[]).length, ws: raw.ws, minuteWeight: recentWeight() }));
      if (rateLimited) throw new Error('Hyperliquid answered 429: the probe stopped');
    }
    expect(plan.length).toBeGreaterThan(0);
  });

  it.skipIf(env.HL_PROBE_FILL_LAG === '0')('measures the fill index lag (userFillsByTime) of a busy address', { timeout: 60 * 60_000 }, async () => {
    // Poll the last window of the address's fills at a fixed cadence through
    // the same metered transport (outside any order session: unscoped).
    const polls: { sentAt: number; receivedAt: number; startTime: number; tids: number[] }[] = [];
    const fills = new Map<number, number>(), statuses = new Set<number>();
    let weight = 0;
    sent = [];
    while (recentWeight() > 0 && Date.now() - (ledger.at(-1)?.at ?? 0) < 30_000) await wait(1000);
    const until = Date.now() + config.fillLagMin * 60_000;
    while (Date.now() < until && !rateLimited) {
      const sentAt = Date.now(), startTime = sentAt - config.fillWindowMs;
      const response = await global.fetchInfo(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'userFillsByTime', user: config.fillAddress, startTime, aggregateByTime: false }) });
      const receivedAt = Date.now();
      statuses.add(response.status);
      if (response.ok) {
        const rows = await response.json() as { tid: number; time: number }[];
        settleListAnswer(response, rows.length);
        const surcharge = infoListSurcharge('userFillsByTime', rows.length);
        weight += 20 + surcharge; ledger.push({ at: receivedAt, weight: surcharge });
        for (const row of rows) fills.set(row.tid, row.time);
        polls.push({ sentAt, receivedAt, startTime, tids: rows.map(row => row.tid) });
      } else weight += 20;
      const next = sentAt + config.fillPollMs - Date.now();
      if (next > 0) await wait(next);
    }
    result.fillLag = { address: config.fillAddress, pollMs: config.fillPollMs, windowMs: config.fillWindowMs, settleMs: 30_000, restWeight: weight,
      statuses: [...statuses], polls, fills: [...fills].map(([tid, time]) => ({ tid, time })) };
    save();
    if (rateLimited) throw new Error('Hyperliquid answered 429: the probe stopped');
    expect(polls.length).toBeGreaterThan(0);
  });
});
