import type { Server } from 'node:http';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminSystemSchema, egressIdentitySchema, heartbeatResponseSchema, type EgressIdentity } from '@trading-dashboard/shared/contracts';
import { AdminSystemService } from '../src/admin/admin-system.service.js';
import { WorkerFleetService } from '../src/api/health/worker-fleet.service.js';
import { egressLeaseGuard, gatedLeaseAcquire } from '../src/bootstrap/worker.bootstrap.js';
import { startWorkerHealthServer } from '../src/bootstrap/worker-health-server.js';
import { AppConfig } from '../src/config/app-config.js';
import { validateEnvironment } from '../src/config/runtime-config.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { EGRESS_IP_TTL_MS, EGRESS_STARTUP_SAMPLES, EgressIdentityMonitor, EgressLeaseGuard, egressLeaseVerdict, sharedIps } from '../src/runtime/egress-identity.js';
import { workerMonitorKey } from '../src/runtime/worker-calls.js';
import type { WorkerRole } from '../src/runtime/worker-role.js';
import { WorkerHeartbeatService } from '../src/worker/worker-heartbeat.service.js';
import { testConfig } from './config-test-utils.js';
import { ALERT_EVERY_MS } from '../src/config/constants/alerts.js';

// Railway static egress (an HA gateway, three shared IPs) is on the copy
// worker only (design §8 I-15): the api and the read worker keep the default
// egress. Every process learns its public IPv4 from an echo (stubbed here:
// no real network), the api compares the sets, and the copy worker under
// enforce refuses its lease on a shared address.
const T0 = 1_792_000_000_000;
const GATEWAY = ['208.77.246.240', '208.77.246.241', '208.77.246.242'];
const DEFAULT_POOL = ['34.1.2.3', '34.1.2.4'];
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const DB = 'postgres://worker:secret@db.internal:5432/orbie';
const KEY = workerMonitorKey(DB);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** An echo that answers `answers` in turn (the last one again after). */
function echo(...answers: Array<string | Error>) {
  let next = 0;
  return vi.fn(async (input: string | URL) => {
    void input;
    const answer = answers[Math.min(next++, answers.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return new Response(`${answer}\n`, { status: 200 });
  });
}
function monitor(fetcher: typeof fetch, clock = { now: T0 }, mode: 'observe' | 'enforce' = 'observe', role: WorkerRole | 'api' = 'copy') {
  return new EgressIdentityMonitor(fetcher, () => clock.now).configure({ role, egressKey: `stage-${role}`, logger: quiet,
    config: { mode, echoUrls: ['https://api.ipify.org', 'https://checkip.amazonaws.com'], timeoutMs: 3000, intervalMs: 300_000 } });
}
const identity = (role: EgressIdentity['role'], publicIps: string[]): EgressIdentity =>
  ({ role, egressKey: `stage-${role}`, mode: 'observe', publicIp: publicIps.at(-1) ?? null, publicIps, observedAt: new Date(T0).toISOString(), lastError: null });

describe('each process learns its public IPv4 set from a stubbed echo', () => {
  it('records every address the gateway answers from, falls back to the next echo, and forgets an address after a day', async () => {
    const clock = { now: T0 };
    const fetcher = echo(GATEWAY[0]!, new Error('timeout'), GATEWAY[2]!);
    const m = monitor(fetcher as unknown as typeof fetch, clock);
    expect(await m.observe()).toBe(GATEWAY[0]);
    // The first echo fails: the second answers.
    expect(await m.observe()).toBe(GATEWAY[2]);
    expect(fetcher.mock.calls.map(c => new URL(String(c[0])).host)).toEqual(['api.ipify.org', 'api.ipify.org', 'checkip.amazonaws.com']);
    expect(m.ips()).toEqual([GATEWAY[0], GATEWAY[2]]);
    expect(egressIdentitySchema.parse(m.snapshot())).toMatchObject({ role: 'copy', egressKey: 'stage-copy', mode: 'observe', publicIp: GATEWAY[2], publicIps: [GATEWAY[0], GATEWAY[2]], lastError: null });
    clock.now += EGRESS_IP_TTL_MS - 1;
    await m.observe();
    clock.now += 2;
    expect(m.ips()).toEqual([GATEWAY[2]]);
  });

  it('the default echoes are three independent providers: the third answers when the first two fail; all three down still fails closed', async () => {
    const { echoUrls } = validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: DB, IS_WORKER: 'true', WORKER_ROLE: 'copy', HL_EGRESS_IDENTITY: 'enforce', HL_EGRESS_PEERS: 'http://api.internal:3000' }).egressIdentity;
    expect(new Set(echoUrls.map(url => new URL(url).hostname.split('.').slice(-2).join('.'))).size).toBeGreaterThanOrEqual(3);
    const configured = (fetcher: unknown) => new EgressIdentityMonitor(fetcher as typeof fetch, () => T0).configure({ role: 'copy', egressKey: 'stage-copy', logger: quiet,
      config: { mode: 'enforce', echoUrls, timeoutMs: 3000, intervalMs: 300_000 } });
    // ipify times out, Amazon answers 503: the third answers.
    const fallback = vi.fn(async (input: string | URL) => {
      const host = new URL(String(input)).hostname;
      if (host === 'api.ipify.org') throw new Error('timeout');
      if (host === 'checkip.amazonaws.com') return new Response('', { status: 503 });
      return new Response(`${GATEWAY[1]}\n`, { status: 200 });
    });
    const m = configured(fallback);
    expect(await m.observe()).toBe(GATEWAY[1]);
    expect(fallback).toHaveBeenCalledTimes(3);
    expect(m.snapshot()).toMatchObject({ publicIps: [GATEWAY[1]], lastError: null });
    // Every echo down: unknown, and the lease verdict refuses (fail closed).
    const down = configured(vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await down.observe()).toBeNull();
    expect(down.snapshot().lastError?.split('; ')).toHaveLength(3);
    expect(egressLeaseVerdict(down.ips(), [])).toMatchObject({ allowed: false, reason: expect.stringMatching(/unknown/) });
  });

  it('no echo answers: null and lastError, never a throw; a non-IPv4 answer does not count', async () => {
    const m = monitor(vi.fn(async () => new Response('<html>blocked</html>', { status: 200 })) as unknown as typeof fetch);
    expect(await m.observe()).toBeNull();
    expect(m.snapshot()).toMatchObject({ publicIp: null, publicIps: [], observedAt: null });
    expect(m.snapshot().lastError).toMatch(/not an IPv4 answer/);
  });

  it('observe never blocks startup: start() returns at once while the echo hangs, and off asks nothing', async () => {
    // The first echo hangs until released; the startup samples after it answer at once.
    let release!: () => void, first = true;
    const hanging = vi.fn(() => {
      if (!first) return Promise.resolve(new Response(GATEWAY[1]!));
      first = false;
      return new Promise<Response>(resolve => { release = () => resolve(new Response(GATEWAY[1]!)); });
    });
    const m = monitor(hanging as unknown as typeof fetch);
    const started = performance.now();
    m.start();
    expect(performance.now() - started).toBeLessThan(50);
    expect(hanging).toHaveBeenCalledTimes(1);
    expect(m.snapshot().publicIp).toBeNull();
    release();
    await vi.waitFor(() => expect(hanging).toHaveBeenCalledTimes(EGRESS_STARTUP_SAMPLES));
    await vi.waitFor(() => expect(m.snapshot().publicIp).toBe(GATEWAY[1]));
    m.stop();
    const off = vi.fn();
    const silent = new EgressIdentityMonitor(off as unknown as typeof fetch).configure({ role: 'copy', egressKey: undefined, config: undefined });
    silent.start();
    expect(off).not.toHaveBeenCalled();
    expect(silent.mode).toBe('off');
  });

  it('HL_EGRESS_IDENTITY defaults to off; enforce is a worker-only value; the expected IPs must be IPv4', () => {
    const base = { NODE_ENV: 'test', DATABASE_URL: DB };
    expect(validateEnvironment(base).egressIdentity).toMatchObject({ mode: 'off', timeoutMs: 3000, echoUrls: ['https://api.ipify.org', 'https://checkip.amazonaws.com', 'https://ipv4.icanhazip.com'], peers: [], expectedIps: [] });
    expect(() => validateEnvironment({ ...base, HL_EGRESS_IDENTITY: 'enforce' })).toThrow(/worker only/);
    const worker = validateEnvironment({ ...base, IS_WORKER: 'true', WORKER_ROLE: 'copy', HL_EGRESS_IDENTITY: 'enforce', HL_EGRESS_PEERS: 'http://api.railway.internal:3000, http://worker-read.railway.internal:3000',
      HL_EGRESS_EXPECTED_IPS: GATEWAY.join(',') }).egressIdentity;
    expect(worker).toMatchObject({ mode: 'enforce', peers: ['http://api.railway.internal:3000', 'http://worker-read.railway.internal:3000'], expectedIps: GATEWAY });
    expect(() => validateEnvironment({ ...base, HL_EGRESS_EXPECTED_IPS: '2001:db8::1' })).toThrow(/IPv4/);
  });

  it('enforce with no HL_EGRESS_PEERS is refused at startup: with nothing to compare, every lease would be allowed', () => {
    const copy = { NODE_ENV: 'test', DATABASE_URL: DB, IS_WORKER: 'true', WORKER_ROLE: 'copy', HL_EGRESS_IDENTITY: 'enforce' };
    expect(() => validateEnvironment(copy)).toThrow(/HL_EGRESS_IDENTITY=enforce needs HL_EGRESS_PEERS/);
    expect(() => validateEnvironment({ ...copy, HL_EGRESS_PEERS: ' , ' })).toThrow(/needs HL_EGRESS_PEERS/);
    expect(() => validateEnvironment({ ...copy, WORKER_ROLE: 'all', HL_EGRESS_EXPECTED_IPS: GATEWAY.join(',') })).toThrow(/needs HL_EGRESS_PEERS/);
    // One peer is enough; observe needs none.
    expect(validateEnvironment({ ...copy, HL_EGRESS_PEERS: 'http://api.railway.internal:3000' }).egressIdentity).toMatchObject({ mode: 'enforce', peers: ['http://api.railway.internal:3000'] });
    expect(validateEnvironment({ ...copy, HL_EGRESS_IDENTITY: 'observe' }).egressIdentity).toMatchObject({ mode: 'observe', peers: [] });
  });
});

describe('enforce: the copy worker refuses its lease on a shared egress (fail closed)', () => {
  const runtime = (mode: 'off' | 'observe' | 'enforce', role: WorkerRole) => ({ ...validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: DB, IS_WORKER: 'true', WORKER_ROLE: role, HL_EGRESS_IDENTITY: mode,
    HL_EGRESS_PEERS: 'http://api.internal:3000,http://worker-read.internal:3000' }) });
  /** Peers answering their identities by host (the monitor key checked). */
  function peers(byHost: Record<string, EgressIdentity | null>) {
    return vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/health/egress');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
      const body = byHost[url.hostname];
      return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('', { status: 404 });
    });
  }
  /** A lease client that records whether the lock was asked for. */
  const leaseClient = () => ({ query: vi.fn(async (sql: string) => { void sql; return { rows: [{ acquired: true }] }; }) });

  it('a copy IP set that overlaps the api\'s refuses the lease (no lock query); a distinct set takes it', async () => {
    const own = monitor(echo(GATEWAY[0]!, GATEWAY[1]!) as unknown as typeof fetch, { now: T0 }, 'enforce');
    await own.observe(); await own.observe();
    const clock = { now: T0 };
    // The api's default egress happens to be one of the gateway's addresses.
    const shared = peers({ 'api.internal': identity('api', [DEFAULT_POOL[0]!, GATEWAY[1]!]), 'worker-read.internal': identity('read', [DEFAULT_POOL[1]!]) });
    const error = vi.fn();
    const guard = egressLeaseGuard(runtime('enforce', 'copy'), { ...quiet, error }, { fetcher: shared as unknown as typeof fetch, now: () => clock.now, monitor: own })!;
    expect(guard).toBeInstanceOf(EgressLeaseGuard);
    const client = leaseClient();
    expect(await gatedLeaseAcquire(guard, [1])(client as never)).toBe(false);
    expect(client.query).not.toHaveBeenCalled();
    expect(String(error.mock.calls[0]?.[0])).toMatch(/^ALERT egress_identity_lease_refused: .*"shared":\["208\.77\.246\.241"\].*"peers":\["api"\]/);
    // Distinct sets: the lease is taken.
    const distinct = peers({ 'api.internal': identity('api', [DEFAULT_POOL[0]!]), 'worker-read.internal': identity('read', [DEFAULT_POOL[1]!]) });
    const fresh = egressLeaseGuard(runtime('enforce', 'copy'), quiet, { fetcher: distinct as unknown as typeof fetch, now: () => clock.now, monitor: own })!;
    expect(await gatedLeaseAcquire(fresh, [1])(client as never)).toBe(true);
    expect(client.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock(73106, 1) AS acquired');
  });

  it('the read worker sharing an address refuses too; the verdict is kept for a minute, then decided again', async () => {
    const own = monitor(echo(GATEWAY[2]!) as unknown as typeof fetch, { now: T0 }, 'enforce');
    await own.observe();
    const clock = { now: T0 };
    let read = identity('read', [GATEWAY[2]!]);
    const fetcher = vi.fn(async (input: string | URL) => new Response(JSON.stringify(new URL(String(input)).hostname === 'worker-read.internal' ? read : identity('api', [DEFAULT_POOL[0]!]))));
    const guard = egressLeaseGuard(runtime('enforce', 'copy'), quiet, { fetcher: fetcher as unknown as typeof fetch, now: () => clock.now, monitor: own })!;
    expect(await guard.allows()).toBe(false);
    read = identity('read', [DEFAULT_POOL[1]!]);
    clock.now += 30_000;
    expect(await guard.allows()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    clock.now += 30_000;
    expect(await guard.allows()).toBe(true);
  });

  it('no address of its own is refused (fail closed); an unreadable peer proves nothing; an address outside the expected gateway is refused', () => {
    expect(egressLeaseVerdict([], [])).toMatchObject({ allowed: false, reason: expect.stringMatching(/unknown/) });
    expect(egressLeaseVerdict([GATEWAY[0]!], [{ url: 'http://api.internal:3000', error: 'HTTP 503' }])).toMatchObject({ allowed: true });
    expect(egressLeaseVerdict([DEFAULT_POOL[0]!], [], GATEWAY)).toMatchObject({ allowed: false, shared: [DEFAULT_POOL[0]], reason: expect.stringMatching(/HL_EGRESS_EXPECTED_IPS/) });
    expect(egressLeaseVerdict(GATEWAY, [{ url: 'x', identity: identity('api', DEFAULT_POOL) }], GATEWAY)).toMatchObject({ allowed: true, ips: GATEWAY });
    expect(sharedIps(['b', 'a', 'a'], ['a', 'c'])).toEqual(['a']);
  });

  it('off and observe never gate the lease, nor does enforce on a read worker', async () => {
    expect(egressLeaseGuard(runtime('off', 'copy'), quiet)).toBeUndefined();
    expect(egressLeaseGuard(runtime('observe', 'copy'), quiet)).toBeUndefined();
    expect(egressLeaseGuard(runtime('enforce', 'read'), quiet)).toBeUndefined();
    expect(egressLeaseGuard(runtime('enforce', 'all'), quiet)).toBeInstanceOf(EgressLeaseGuard);
    const client = leaseClient();
    expect(await gatedLeaseAcquire(undefined, [2])(client as never)).toBe(true);
  });

  it('a worker serves its identity on /health/egress only with the monitor key, also on standby', async () => {
    const own = monitor(echo(GATEWAY[0]!) as unknown as typeof fetch);
    await own.observe();
    const server: Server = await startWorkerHealthServer({ instanceId: 'w-1', state: () => 'standby', probe: async () => undefined, monitorKey: KEY,
      heartbeat: async () => ({}) as never, monitor: async () => ({}), egress: () => own.snapshot() }, 0, '127.0.0.1');
    try {
      const address = server.address(), port = typeof address === 'object' && address ? address.port : 0;
      expect((await fetch(`http://127.0.0.1:${port}/health/egress`)).status).toBe(404);
      const answer = await fetch(`http://127.0.0.1:${port}/health/egress`, { headers: { Authorization: `Bearer ${KEY}` } });
      expect(egressIdentitySchema.parse(await answer.json())).toMatchObject({ role: 'copy', publicIps: [GATEWAY[0]] });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

describe('the api compares the copy worker\'s IP set with its own and the read worker\'s (WorkerFleetService)', () => {
  const clock = { now: T0 };
  const config = () => { const base = testConfig().value; return new AppConfig({ ...base, app: { ...base.app, workerUrl: 'http://worker-copy:3000', workerReadUrl: 'http://worker-read:3000' } } as never); };
  const sample = (role: WorkerRole, egress?: EgressIdentity) => ({
    state: 'active', instanceId: `w-${role}`, sampledAt: new Date(clock.now).toISOString(), uptimeSeconds: 60,
    budget: { requestsLastMinute: 0, weightLastMinute: 0, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null, queued: { live: 0, background: 0 } },
    heartbeat: { feedConnected: true, feedSocketsOpen: 1, feedSocketsTotal: 1, marketsSubscribed: 1, feedDisconnectedSince: null, lastTradeAt: null, lastFillAt: null,
      lastSnapshotAt: new Date(clock.now).toISOString(), lastSweepAt: null, requestsLastMinute: 0, weightLastMinute: 0, queuedRequests: { live: 0, background: 0 }, fillsUnavailable: [], dryRun: true,
      worker: { role, leases: role === 'copy' ? [1] : [2] }, ...(egress ? { egressIdentity: egress } : {}), now: new Date(clock.now).toISOString() },
  });

  it('shared sets alert (rate-limited ALERT line, admin overview), distinct sets clear it', async () => {
    clock.now = T0;
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    let copy = identity('copy', [GATEWAY[0]!, GATEWAY[1]!]), read = identity('read', [DEFAULT_POOL[1]!]);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const host = new URL(String(input)).hostname;
      return { ok: true, json: async () => host === 'worker-read' ? sample('read', read) : sample('copy', copy) };
    }));
    // The api's own default egress: one of its addresses is the gateway's.
    const api = monitor(echo(DEFAULT_POOL[0]!, GATEWAY[1]!) as unknown as typeof fetch, clock, 'observe', 'api');
    await api.observe();
    const service = new WorkerFleetService(config(), () => clock.now, api);
    expect(await service.check()).toEqual([]);
    await api.observe();
    clock.now += 1000;
    expect(await service.check()).toEqual([{ code: 'egress_identity_shared', lastOkAt: new Date(T0).toISOString(), ips: [GATEWAY[1]], peers: ['api'] }]);
    const lines = () => error.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('ALERT egress_identity_shared'));
    expect(lines()).toHaveLength(1);
    clock.now += 60_000; await service.check();
    expect(lines()).toHaveLength(1);
    // The read worker now shares one too: both peers.
    read = identity('read', [GATEWAY[0]!]);
    clock.now += ALERT_EVERY_MS; await service.check();
    expect(lines()).toHaveLength(2);
    expect(service.alerts()).toEqual([{ code: 'egress_identity_shared', lastOkAt: new Date(T0).toISOString(), ips: [GATEWAY[0], GATEWAY[1]], peers: ['api', 'read'] }]);
    // The admin overview shows it.
    const repository = { probe: vi.fn().mockResolvedValue(3), data: vi.fn().mockResolvedValue(null), outbox: vi.fn().mockResolvedValue([]), retention: vi.fn().mockResolvedValue(null) };
    const budget = { requestsLastMinute: 1, weightLastMinute: 20, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null };
    const overview = adminSystemSchema.parse(await new AdminSystemService(repository as never, config(), { introspect: () => budget, queued: () => ({ live: 0, background: 0 }) } as never, service).overview());
    expect(overview.alerts?.map(a => [a.code, a.peers])).toEqual([['egress_identity_shared', ['api', 'read']]]);
    // The copy worker moves to addresses nobody else has: cleared.
    copy = identity('copy', [GATEWAY[2]!]);
    clock.now += 1000;
    expect(await service.check()).toEqual([]);
  });
});

describe('the heartbeat reports the egress identity', () => {
  async function beat(identityMonitor: EgressIdentityMonitor) {
    const config = testConfig(), budgeter = new RequestBudgeterService(config);
    const watcher = { getHeartbeat: () => ({ feed: { socketsTotal: 1, socketsOpen: 1, markets: 1, disconnectedSince: null, lastTradeAt: null }, lastFillAt: null, lastSweepAt: null, fillsUnavailable: [] }) };
    try { return await new WorkerHeartbeatService(config, watcher as never, null, budgeter, undefined, undefined, undefined, identityMonitor).heartbeat(); }
    finally { budgeter.onModuleDestroy(); }
  }
  it('{role, egressKey, publicIp, publicIps, observedAt} while observing; absent while off', async () => {
    const m = monitor(echo(GATEWAY[0]!) as unknown as typeof fetch);
    await m.observe();
    const heartbeat = heartbeatResponseSchema.parse(await beat(m));
    expect(heartbeat.egressIdentity).toEqual({ role: 'copy', egressKey: 'stage-copy', mode: 'observe', publicIp: GATEWAY[0], publicIps: [GATEWAY[0]], observedAt: new Date(T0).toISOString(), lastError: null });
    expect((await beat(new EgressIdentityMonitor())).egressIdentity).toBeUndefined();
  });
});
