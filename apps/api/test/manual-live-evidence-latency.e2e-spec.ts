import { createServer, connect, type Server, type Socket } from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '@trading-dashboard/shared/database';
import { describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { sharedRestRetryAfterMs } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { PostgresLiveRiskScope } from '../src/copy/live/postgres-live-risk-scope.js';
import { HyperliquidAllDexsAccountSource, PerReadAllDexsAccountSource } from '../src/copy/live/live-account-ws-source.js';
import { HyperliquidLiveAccountObserver } from '../src/copy/live/live-account-observer.js';
import { HyperliquidLiveMarketResolver } from '../src/copy/live/live-market-resolver.js';
import { HyperliquidLiveRiskProvider } from '../src/copy/live/live-risk-provider.js';
import { LiveProviderReadEpoch } from '../src/copy/live/live-provider-read-epoch.js';
import { originalLiveInfoBatch } from '../src/copy/live/live-execution-runtime.js';
import { liveReadCache } from '../src/copy/live/live-read-cache.js';
import { LiveSpanRecorder, type LiveExecutionTiming } from '../src/copy/live/live-execution-diagnostics.js';

/**
 * Manual probe (real mainnet Hyperliquid, read-only info + WS; a real local
 * Postgres meter): where an order's evidence epoch spends its time.
 *
 *   E2E_RUN_LIVE_EVIDENCE=1   required
 *   E2E_DB_RTT_MS=8           round trip added to every SQL connection (Stage-like)
 *   E2E_CONTENTION=1          background acquirers and socket leases on the same meter
 *   E2E_RUNS=3                epochs per case (paced: at most two a minute)
 *
 * Only the SQL authority's content is a double (the order's accounts and
 * leader); its read is still a real transaction on the original session.
 */
const FOLLOWER = '0x22db34fabab460c7d807357bca73dc3744c50496';
const LEADER = '0x2e30c32738a28833e3d85189c04895c25ee54cb5';
vi.mock('../src/copy/live/postgres-live-risk-authority.js', async original => {
  const actual = await original<typeof import('../src/copy/live/postgres-live-risk-authority.js')>();
  return { ...actual, loadLivePreparationAuthority: async (session: { scope: { assertHeld(): Promise<void> } }, db: { execute(q: unknown): Promise<unknown> }) => {
    await db.execute(sql`select 1`); await session.scope.assertHeld();
    return { account: { id: 'account', network: 'mainnet', address: FOLLOWER }, accounts: [{ id: 'account', address: FOLLOWER }],
      consent: { leaderAddress: LEADER }, limits: { maxLeverage: 50 }, settings: { maxLeverage: null } };
  } };
});

/** Delays every chunk by half the round trip each way, in order. */
function latencyProxy(target: URL, rttMs: number): Promise<{ server: Server; port: number }> {
  const pipe = (from: Socket, to: Socket) => {
    let tail = Promise.resolve();
    from.on('data', chunk => { const at = Date.now() + rttMs / 2; tail = tail.then(async () => { const left = at - Date.now(); if (left > 0) await wait(left); to.write(chunk); }); });
    from.on('end', () => { void tail.then(() => to.end()); });
    from.on('error', () => to.destroy());
  };
  const server = createServer(client => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    pipe(client, upstream); pipe(upstream, client);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port })));
}

/** Stage-like pressure on the same egress key: background loops that keep the
 * background lane full and retry, and socket leases that come and go. */
function contention(quota: PostgresHyperliquidQuota, egressKey: string, stop: AbortSignal) {
  const counts = { granted: 0, refused: 0, sockets: 0, socketRefused: 0 };
  const background = async (n: number) => {
    const bound = quota.bindUnscoped({ egressKey, ownerId: `background-${n}` });
    while (!stop.aborted) {
      try { await bound.acquireRest(20, Date.now() + 5000, 'background'); counts.granted++; await wait(50); }
      catch (error) { counts.refused++; const retry = sharedRestRetryAfterMs(error); await wait(Math.min(retry ?? 250, 250 + Math.random() * 250)); }
    }
  };
  const sockets = async (n: number) => {
    const bound = quota.bindUnscoped({ egressKey, ownerId: `socket-${n}` });
    while (!stop.aborted) {
      try { const r = await bound.reserveSocket(Date.now() + 5000, 'mainnet'); counts.sockets++; await r.connection.cancelBeforeConnect(); }
      catch { counts.socketRefused++; }
      await wait(4000);
    }
  };
  return { counts, done: Promise.all([...Array.from({ length: 8 }, (_, n) => background(n)), ...Array.from({ length: 2 }, (_, n) => sockets(n))]) };
}

describe.skipIf(process.env.E2E_RUN_LIVE_EVIDENCE !== '1')('live evidence latency (manual, mainnet)', () => {
  it('breaks one order evidence epoch into its spans', { timeout: 15 * 60_000 }, async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!), rtt = Number(process.env.E2E_DB_RTT_MS ?? 0), runs = Number(process.env.E2E_RUNS ?? 3);
    const proxy = rtt > 0 ? await latencyProxy(url, rtt) : undefined;
    const viaProxy = new URL(url); if (proxy) { viaProxy.hostname = '127.0.0.1'; viaProxy.port = String(proxy.port); }
    const pool = new Pool({ connectionString: viaProxy.toString(), max: 6 });
    const backgroundPool = new Pool({ connectionString: viaProxy.toString(), max: 12 });
    const egressKey = 'manual-evidence-probe';
    const quota = new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema })));
    const global = new HyperliquidGlobalTransport(quota, { egressKey, ownerId: 'probe-api' });
    const stop = new AbortController();
    const pressure = process.env.E2E_CONTENTION === '1' ? contention(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(backgroundPool, { schema }))), egressKey, stop.signal) : undefined;
    const results: { ok: boolean; error?: string; stages: Record<string, number>; spans: ReturnType<LiveSpanRecorder['summary']> }[] = [];
    try {
      if (pressure) await wait(3000);
      for (let run = 0; run < runs; run++) {
        if (run) await wait(30_000);
        const timings: LiveExecutionTiming[] = [], recorder = new LiveSpanRecorder();
        let error: string | undefined;
        await recorder.run(() => new PostgresLiveRiskScope(pool).run({ userId: 1, network: 'mainnet', accountAddress: FOLLOWER, source: { network: 'mainnet', leaderAddress: LEADER } },
          async (_scope, session) => global.runOriginal(session, async () => {
            const acquire = async () => {};
            const sockets = new PerReadAllDexsAccountSource(() => new HyperliquidAllDexsAccountSource(Date.now, undefined, 'mainnet', global), 3);
            const observer = new HyperliquidLiveAccountObserver('mainnet', acquire, global.fetchInfo, Date.now, 5000, sockets);
            const resolver = new HyperliquidLiveMarketResolver('mainnet', acquire, global.fetchInfo, Date.now);
            const provider = new HyperliquidLiveRiskProvider('mainnet', acquire, global.fetchInfo, Date.now);
            const epoch = new LiveProviderReadEpoch(observer, resolver, provider, { extraRiskBufferBps: '0', restingOrderBuilderFeeCapTenthsBps: 0 }, Date.now,
              { acquire, fetcher: global.fetchInfo, batch: originalLiveInfoBatch('mainnet', global, () => session.scope.assertFresh()), cache: liveReadCache('mainnet') },
              event => { timings.push(event); });
            try { await epoch.collect(session, { accountId: 'account', mandateId: 'mandate', key: `probe-${run}`, coin: process.env.E2E_COIN ?? 'BTC', includeLeader: true, checkLeverage: true }); }
            catch (e) { error = e instanceof Error ? (e as { code?: string }).code ?? e.message : String(e); }
            finally { provider.close(); await sockets.close(); }
          }))).catch((e: unknown) => { error ??= e instanceof Error ? (e as { code?: string }).code ?? e.message : String(e); });
        const stages = Object.fromEntries(timings.map(t => [t.stage, t.elapsedMs]));
        results.push({ ok: !error, ...(error ? { error } : {}), stages, spans: recorder.summary() });
        console.log(JSON.stringify({ case: { rttMs: rtt, contention: !!pressure, run }, ok: !error, error, stages, total: timings.at(-1)?.totalMs, pressure: pressure?.counts }));
        for (const s of recorder.summary()) console.log(`  ${s.span.padEnd(32)} n=${String(s.count).padStart(2)} total=${String(s.totalMs).padStart(5)} max=${String(s.maxMs).padStart(5)} [${s.firstAtMs}..${s.lastEndMs}]`);
      }
    } finally {
      stop.abort(); await pressure?.done.catch(() => {});
      await pool.end(); await backgroundPool.end(); proxy?.server.close();
    }
    expect(results.length).toBe(runs);
  });
});
