import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminSystemSchema } from '@trading-dashboard/shared/contracts';
import { AdminSystemService } from '../src/admin/admin-system.service.js';
import { HealthService } from '../src/api/health/health.service.js';
import { SNAPSHOT_STALE_MS, WORKER_ALERT_EVERY_MS, WorkerFleetService } from '../src/api/health/worker-fleet.service.js';
import { AppConfig } from '../src/config/app-config.js';
import { validateEnvironment } from '../src/config/runtime-config.js';
import type { WorkerRole } from '../src/runtime/worker-role.js';
import { testConfig } from './config-test-utils.js';

// WORKER_READ_URL: once the roles are split, snapshots (lastSnapshotAt) are
// only in the read worker's heartbeat. The api reads both workers, merges
// them for /health and the admin overview, and alerts on stale snapshots.
const T0 = 1_792_000_000_000;
const COPY = 'http://worker-copy:3000', READ = 'http://worker-read:3000';
function configOf(readUrl?: string) {
  const base = testConfig().value;
  return new AppConfig({ ...base, app: { ...base.app, isWorker: false, workerUrl: COPY, workerReadUrl: readUrl } });
}
const iso = (at: number) => new Date(at).toISOString();
/** A heartbeat as a worker of `role` reports it at `at` (JSON: dates as strings). */
const beat = (role: WorkerRole, at: number, extra: Record<string, unknown> = {}) => ({
  feedConnected: role !== 'read', feedSocketsOpen: role !== 'read' ? 2 : 0, feedSocketsTotal: role !== 'read' ? 2 : 0, marketsSubscribed: 329, feedDisconnectedSince: null,
  lastTradeAt: iso(at - 1000), lastFillAt: iso(at - 2000), lastSnapshotAt: null, lastSnapshotAttemptAt: null, lastSnapshotFailureAt: null, lastSweepAt: null,
  requestsLastMinute: 1, weightLastMinute: 2, queuedRequests: { live: 0, background: 0 }, fillsUnavailable: [], dryRun: false,
  worker: { role, leases: role === 'copy' ? [1] : role === 'read' ? [2] : [1, 2], terminalSettlement: false }, now: iso(at), ...extra,
});
const monitor = (heartbeat: unknown, at: number, state = 'active', settings: unknown[] = []) => ({
  state, instanceId: `w-${String((heartbeat as { worker?: { role?: string } } | null)?.worker?.role)}`, sampledAt: iso(at), uptimeSeconds: 600, settings,
  budget: state === 'active' ? { requestsLastMinute: 0, weightLastMinute: 0, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null, queued: { live: 0, background: 0 } } : null,
  heartbeat: state === 'active' ? heartbeat : null,
});
const appliedRead = [{ consumer: 'pool', revision: 'a'.repeat(64), checkedAt: iso(T0), recovered: false, candidatePoolSize: 1000, poolWeightPerMinute: 240, leaderboardRefreshMinutes: 60 }];

/** `fetch` answering per worker: `copy` and `read` give the body for each path, undefined is a 503. */
function workers(copy: (path: string) => unknown, read: (path: string) => unknown) {
  const fetcher = vi.fn(async (url: URL | string) => {
    const u = new URL(String(url)), body = u.origin === new URL(COPY).origin ? copy(u.pathname) : u.origin === new URL(READ).origin ? read(u.pathname) : undefined;
    return body === undefined ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => body };
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const clock = { now: T0 };
const later = (ms: number) => { clock.now += ms; };
const repository = { probe: vi.fn().mockResolvedValue(3), data: vi.fn().mockResolvedValue(null), outbox: vi.fn().mockResolvedValue([]), retention: vi.fn().mockResolvedValue(null) };
const budget = { requestsLastMinute: 1, weightLastMinute: 20, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null };
const overview = (config: AppConfig, fleet: WorkerFleetService) =>
  new AdminSystemService(repository as never, config, { introspect: () => budget, queued: () => ({ live: 0, background: 0 }) } as never, fleet).overview().then(v => adminSystemSchema.parse(v));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('WORKER_READ_URL', () => {
  it('is an optional http(s) URL', () => {
    const env = { NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/read_url_test' };
    expect(validateEnvironment(env).app.workerReadUrl).toBeUndefined();
    expect(validateEnvironment({ ...env, WORKER_URL: COPY, WORKER_READ_URL: READ }).app).toMatchObject({ workerUrl: COPY, workerReadUrl: READ });
    expect(() => validateEnvironment({ ...env, WORKER_READ_URL: 'ftp://worker-read' })).toThrow(/WORKER_READ_URL/);
  });

  it('only WORKER_URL (an `all` worker): /health and the admin overview are that worker\'s heartbeat as before, one read each, and no snapshot alert', async () => {
    clock.now = T0;
    const all = beat('all', T0, { lastSnapshotAt: iso(T0 - 60_000) });
    const fetcher = workers(path => path === '/health' ? all : monitor(all, clock.now), () => { throw Error('no read worker'); });
    const config = configOf(), fleet = new WorkerFleetService(config, () => clock.now);
    expect(await new HealthService(fleet).heartbeat()).toEqual(all);
    const result = await overview(config, fleet);
    expect(result.worker.sample?.heartbeat).toEqual(all);
    expect(result).not.toHaveProperty('workerRead');
    expect(fetcher.mock.calls.map(c => String(c[0]))).toEqual([`${COPY}/health`, `${COPY}/health/monitor`]);
    later(SNAPSHOT_STALE_MS * 4);
    expect(await fleet.check()).toEqual([]);
  });

  it('with the split, /health is the copy worker\'s feed with the read worker\'s snapshots, sweeps, discovery, archive and dry run', async () => {
    clock.now = T0;
    const discovery = { visibleRows: 180, medianVisibleAgeSeconds: 60, oldestVisibleAgeSeconds: 600, poolRows: 1000, poolReady: 950, medianPoolAgeSeconds: 300, oldestPoolAgeSeconds: 3600 };
    const copy = beat('copy', T0, { lastSweepAt: iso(T0 - 300_000) });
    const read = beat('read', T0, { lastSnapshotAt: iso(T0 - 60_000), lastSnapshotAttemptAt: iso(T0 - 60_000), lastSweepAt: iso(T0 - 30_000), discovery, dryRun: true });
    let readUp = true;
    workers(() => copy, () => readUp ? read : undefined);
    const fleet = new WorkerFleetService(configOf(READ), () => clock.now), health = new HealthService(fleet);
    const merged = await health.heartbeat();
    expect(merged).toMatchObject({ feedConnected: true, feedSocketsOpen: 2, lastTradeAt: copy.lastTradeAt, worker: copy.worker,
      lastSnapshotAt: read.lastSnapshotAt, lastSnapshotAttemptAt: read.lastSnapshotAttemptAt, lastSweepAt: read.lastSweepAt, discovery, dryRun: true });
    // A read worker that cannot be reached does not fail /health: the copy worker's heartbeat as it is.
    readUp = false;
    expect(await health.heartbeat()).toEqual(copy);
    // The copy worker is the one /health needs (the feed): without it, 503.
    workers(() => undefined, () => read);
    await expect(health.heartbeat()).rejects.toMatchObject({ status: 503 });
  });

  it('the admin overview merges the read worker into the worker sample (heartbeat fields, discovery settings) and shows it as workerRead', async () => {
    clock.now = T0;
    const copy = beat('copy', T0), read = beat('read', T0, { lastSnapshotAt: iso(T0 - 60_000) });
    let readState = 'active';
    workers(() => monitor(copy, clock.now), () => monitor(read, clock.now, readState, appliedRead));
    const config = configOf(READ), fleet = new WorkerFleetService(config, () => clock.now);
    const result = await overview(config, fleet);
    expect(result.worker.state).toBe('active');
    expect(result.worker.sample?.heartbeat).toMatchObject({ feedConnected: true, lastSnapshotAt: iso(T0 - 60_000), worker: { role: 'copy' } });
    expect(result.worker.sample?.settings).toEqual(appliedRead);
    expect(result.workerRead).toMatchObject({ state: 'active', sample: { heartbeat: { worker: { role: 'read' } } } });
    // A read worker on standby is shown as such and merges nothing.
    readState = 'standby';
    const standby = await overview(config, new WorkerFleetService(config, () => clock.now));
    expect(standby.workerRead?.state).toBe('standby');
    expect(standby.worker.sample?.heartbeat?.lastSnapshotAt).toBeNull();
  });

  it('alerts when the read worker shows no snapshot for 15 minutes (stale, failing, unreachable), rate-limited, and clears on a fresh one', async () => {
    clock.now = T0;
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    let snapshotAt: number | null = T0 - 60_000, readUp = true;
    // The copy worker's own (null) or a claimed snapshot never counts: only the read worker proves it.
    workers(() => monitor(beat('copy', clock.now, { lastSnapshotAt: iso(clock.now) }), clock.now),
      () => readUp ? monitor(beat('read', clock.now, { lastSnapshotAt: snapshotAt === null ? null : iso(snapshotAt) }), clock.now) : undefined);
    const config = configOf(READ), fleet = new WorkerFleetService(config, () => clock.now);
    expect(await fleet.check()).toEqual([]);
    // Snapshots stop (failing runs keep lastSnapshotAt where it was).
    later(SNAPSHOT_STALE_MS - 60_000);
    expect(await fleet.check()).toEqual([]);
    later(1);
    expect(await fleet.check()).toEqual([{ code: 'snapshots_stale', lastOkAt: iso(T0 - 60_000) }]);
    const alerts = () => error.mock.calls.map(c => String(c[0])).filter(line => line.startsWith('ALERT snapshots_stale'));
    expect(alerts()).toHaveLength(1);
    later(60_000); await fleet.check();
    expect(alerts()).toHaveLength(1);
    expect((await overview(config, fleet)).alerts).toEqual([{ code: 'snapshots_stale', lastOkAt: iso(T0 - 60_000) }]);
    // A fresh snapshot clears it.
    snapshotAt = clock.now - 5000;
    expect(await fleet.check()).toEqual([]);
    // The read worker goes away: the alert comes back a window after its last snapshot.
    readUp = false;
    const last = snapshotAt;
    later(SNAPSHOT_STALE_MS + WORKER_ALERT_EVERY_MS);
    expect(await fleet.check()).toEqual([{ code: 'snapshots_stale', lastOkAt: iso(last) }]);
    expect(alerts()).toHaveLength(2);
  });
});
