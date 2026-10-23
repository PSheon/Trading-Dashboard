import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminSystemSchema, heartbeatResponseSchema, type EgressIdentity } from '@trading-dashboard/shared/contracts';
import { AdminSystemService } from '../src/admin/admin-system.service.js';
import { WorkerFleetService } from '../src/api/health/worker-fleet.service.js';
import { AppConfig } from '../src/config/app-config.js';
import { validateEnvironment } from '../src/config/runtime-config.js';
import { HYPERLIQUID_BACKGROUND_REST_CAP, HYPERLIQUID_REST_CAP, READ_WORKER_BACKGROUND_REST_CAP, READ_WORKER_PAGE_RESERVE } from '../src/config/constants/hyperliquid.js';
import type { DrizzleDb } from '../src/db/drizzle.provider.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { HyperliquidRestCapacityError } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { planHyperliquidQuota, type HyperliquidQuotaEvent, type HyperliquidQuotaState } from '../src/hyperliquid/hyperliquid-global-quota.js';
import { isReadMeterKey, meterOf, readMeterKey } from '../src/hyperliquid/hyperliquid-meter-key.js';
import { PostgresHyperliquidQuota, type HyperliquidMeterSnapshot } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { EgressIdentityMonitor } from '../src/runtime/egress-identity.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { WorkerHeartbeatService } from '../src/worker/worker-heartbeat.service.js';
import { testConfig } from './config-test-utils.js';

/**
 * Decision D12 (2026-10-23): Hyperliquid limits REST weight per public IP and
 * each Railway service has its own, so the read worker (WORKER_ROLE=read)
 * charges its OWN meter, `<HYPERLIQUID_EGRESS_KEY>:read`, 1,200 a minute with
 * background capped at READ_WORKER_BACKGROUND_REST_CAP (900) and
 * READ_WORKER_PAGE_RESERVE (300) kept for its on-demand reads; the copy side
 * (the api and the copy worker) keeps the shared meter and its priorities.
 * HYPERLIQUID_READ_METER=shared on worker-read is the rollback.
 */
const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/meter_test', HYPERLIQUID_EGRESS_KEY: 'stage-egress' };
const read = { ...base, IS_WORKER: 'true', WORKER_ROLE: 'read' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the read meter\'s key is derived from the shared one', () => {
  it('`<key>:read` (and its testnet host) is the read meter; anything else the copy side\'s', () => {
    expect(readMeterKey('stage-egress')).toBe('stage-egress:read');
    expect(meterOf('stage-egress')).toBe('copy');
    expect(meterOf('stage-egress:testnet')).toBe('copy');
    expect(meterOf('stage-egress:read')).toBe('read');
    expect(meterOf('stage-egress:read:testnet')).toBe('read');
    // The segment, not the substring: a key that merely contains the word stays the copy side's.
    expect(isReadMeterKey('stage-reader')).toBe(false);
    expect(isReadMeterKey('readonly:stage')).toBe(false);
  });
  it('the constants: 300 of the 1,200 window reserved, 900 for background, both from the cap', () => {
    expect(READ_WORKER_PAGE_RESERVE).toBe(300);
    expect(READ_WORKER_BACKGROUND_REST_CAP).toBe(900);
    expect(READ_WORKER_BACKGROUND_REST_CAP + READ_WORKER_PAGE_RESERVE).toBe(HYPERLIQUID_REST_CAP);
  });
});

describe('configuration (HYPERLIQUID_READ_METER)', () => {
  it('the read worker charges `<key>:read` by default, with the read cap and a local bucket up to it', () => {
    const { hyperliquid } = validateEnvironment(read);
    expect(hyperliquid).toMatchObject({ meter: 'read', readMeter: 'own', egressKey: 'stage-egress:read', sharedEgressKey: 'stage-egress',
      backgroundRestCap: READ_WORKER_BACKGROUND_REST_CAP, budgetPerMin: READ_WORKER_BACKGROUND_REST_CAP, burst: READ_WORKER_BACKGROUND_REST_CAP });
    // The local bucket may be lowered, never raised above the meter's background cap.
    expect(validateEnvironment({ ...read, HYPERLIQUID_WEIGHT_BUDGET_PER_MIN: '600', HYPERLIQUID_WEIGHT_BURST: '400' }).hyperliquid).toMatchObject({ budgetPerMin: 600, burst: 400 });
    expect(() => validateEnvironment({ ...read, HYPERLIQUID_WEIGHT_BUDGET_PER_MIN: '1000' })).toThrow(/HYPERLIQUID_WEIGHT_BUDGET_PER_MIN/);
    // One machine, one .env: the worker's own variables win, as for the copy worker.
    expect(validateEnvironment({ ...read, HYPERLIQUID_WEIGHT_BUDGET_PER_MIN: '480', HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN: '700' }).hyperliquid.budgetPerMin).toBe(700);
  });
  it('HYPERLIQUID_READ_METER=shared puts the read worker back on the shared meter, as before D12 (the rollback)', () => {
    const { hyperliquid } = validateEnvironment({ ...read, HYPERLIQUID_READ_METER: 'shared', HYPERLIQUID_WEIGHT_BUDGET_PER_MIN: '360' });
    expect(hyperliquid).toMatchObject({ meter: 'copy', readMeter: 'shared', egressKey: 'stage-egress', sharedEgressKey: 'stage-egress', backgroundRestCap: HYPERLIQUID_BACKGROUND_REST_CAP, budgetPerMin: 360 });
    expect(() => validateEnvironment({ ...read, HYPERLIQUID_READ_METER: 'both' })).toThrow(/HYPERLIQUID_READ_METER must be shared or own/);
  });
  it('the api, the copy worker and the single `all` worker stay on the shared meter; the switch is refused there', () => {
    for (const env of [base, { ...base, IS_WORKER: 'true' }, { ...base, IS_WORKER: 'true', WORKER_ROLE: 'copy' }]) {
      expect(validateEnvironment(env).hyperliquid).toMatchObject({ meter: 'copy', egressKey: 'stage-egress', sharedEgressKey: 'stage-egress' });
      expect(() => validateEnvironment({ ...env, HYPERLIQUID_READ_METER: 'own' })).toThrow(/HYPERLIQUID_READ_METER applies to the read worker only/);
    }
  });
  it('a background cap copied from the copy side is refused on the read meter; a shared key that carries the read segment is refused everywhere', () => {
    expect(() => validateEnvironment({ ...read, HYPERLIQUID_BACKGROUND_REST_CAP: '400' })).toThrow(/HYPERLIQUID_BACKGROUND_REST_CAP does not apply to the read worker's own meter/);
    expect(validateEnvironment({ ...read, HYPERLIQUID_READ_METER: 'shared', HYPERLIQUID_BACKGROUND_REST_CAP: '400' }).hyperliquid.backgroundRestCap).toBe(400);
    expect(() => validateEnvironment({ ...base, HYPERLIQUID_EGRESS_KEY: 'stage:read' })).toThrow(/must not contain a `read` segment/);
    // No key at all (local development): no derived key either.
    const { HYPERLIQUID_EGRESS_KEY: _unused, ...noKey } = read;
    expect(validateEnvironment(noKey).hyperliquid).toMatchObject({ meter: 'read', egressKey: undefined, sharedEgressKey: undefined });
  });
});

describe('the quota charges one meter only (owner guard, as the H-R11 owner rule)', () => {
  const uow = new UnitOfWork({} as DrizzleDb);
  it('a read-meter quota refuses the shared key and its testnet host before any round trip', () => {
    const quota = new PostgresHyperliquidQuota(uow, undefined, undefined, READ_WORKER_BACKGROUND_REST_CAP, 'read');
    expect(quota.meterLane).toBe('read');
    expect(() => quota.bindUnscoped({ egressKey: 'stage-egress', ownerId: 'worker-read' })).toThrow('hyperliquid_quota_meter_foreign');
    expect(() => quota.bindUnscoped({ egressKey: 'stage-egress:testnet', ownerId: 'worker-read' })).toThrow('hyperliquid_quota_meter_foreign');
    expect(quota.bindUnscoped({ egressKey: 'stage-egress:read', ownerId: 'worker-read' })).toBeDefined();
    expect(quota.bindUnscoped({ egressKey: 'stage-egress:read:testnet', ownerId: 'worker-read' })).toBeDefined();
  });
  it('a copy-meter quota (the default: the api, the copy worker, every existing caller) refuses the read keys', () => {
    const quota = new PostgresHyperliquidQuota(uow);
    expect(quota.meterLane).toBe('copy');
    expect(() => quota.bindUnscoped({ egressKey: 'stage-egress:read', ownerId: 'api' })).toThrow('hyperliquid_quota_meter_foreign');
    expect(() => quota.bindUnscoped({ egressKey: 'stage-egress:read:testnet', ownerId: 'api' })).toThrow('hyperliquid_quota_meter_foreign');
    expect(quota.bindUnscoped({ egressKey: 'stage-egress', ownerId: 'api' })).toBeDefined();
    expect(quota.bindUnscoped({ egressKey: 'stage-egress:testnet', ownerId: 'api' })).toBeDefined();
    expect(() => new PostgresHyperliquidQuota(uow, undefined, undefined, undefined, 'both' as never)).toThrow('hyperliquid_quota_invalid');
  });
});

describe('the read meter\'s window: background 900, 300 kept', () => {
  const now = 1_792_000_000_000, egressKey = 'stage-egress:read';
  const bg = (i: number, units: number): HyperliquidQuotaEvent => ({ id: `bg:${i}`, kind: 'rest', units, reservedAt: now - 1000, expiresAt: now + 60_000 });
  const state = (events: HyperliquidQuotaEvent[]): HyperliquidQuotaState => ({ egressKey, revision: 1, events, updatedAt: now - 1000 });
  const charge = (events: HyperliquidQuotaEvent[], lane: 'background' | 'page', weight: number) =>
    planHyperliquidQuota({ now, state: state(events), leases: [], backgroundCap: validateEnvironment(read).hyperliquid.backgroundRestCap,
      request: { kind: 'rest', id: lane === 'page' ? 'page:x' : 'bg:x', weight, sendUntil: now + 1000, lane } });
  it('background fills up to 900 and is then refused; a page read still finds the 300', () => {
    const full = Array.from({ length: 9 }, (_, i) => bg(i, 100));
    expect(charge(full.slice(0, 8), 'background', 100).charged).toBe(100);
    expect(() => charge(full, 'background', 1)).toThrow(HyperliquidRestCapacityError);
    expect(charge(full, 'page', READ_WORKER_PAGE_RESERVE).charged).toBe(READ_WORKER_PAGE_RESERVE);
    expect(() => charge(full, 'page', READ_WORKER_PAGE_RESERVE + 1)).toThrow(HyperliquidRestCapacityError);
  });
});

describe('the identity alert flags any two of the three sharing an address', () => {
  const T0 = 1_792_000_000_000, clock = { now: T0 };
  const identity = (role: EgressIdentity['role'], publicIps: string[]): EgressIdentity =>
    ({ role, egressKey: `stage-${role}`, mode: 'observe', publicIp: publicIps.at(-1) ?? null, publicIps, observedAt: new Date(T0).toISOString(), lastError: null });
  const sample = (role: 'copy' | 'read', egress: EgressIdentity) => ({
    state: 'active', instanceId: `w-${role}`, sampledAt: new Date(clock.now).toISOString(), uptimeSeconds: 60,
    budget: { requestsLastMinute: 0, weightLastMinute: 0, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null, queued: { live: 0, background: 0 } },
    heartbeat: { feedConnected: true, feedSocketsOpen: 1, feedSocketsTotal: 1, marketsSubscribed: 1, feedDisconnectedSince: null, lastTradeAt: null, lastFillAt: null,
      lastSnapshotAt: new Date(clock.now).toISOString(), lastSweepAt: null, requestsLastMinute: 0, weightLastMinute: 0, queuedRequests: { live: 0, background: 0 }, fillsUnavailable: [], dryRun: true,
      worker: { role, leases: role === 'copy' ? [1] : [2] }, egressIdentity: egress, now: new Date(clock.now).toISOString() },
  });
  const config = () => { const b = testConfig().value; return new AppConfig({ ...b, app: { ...b.app, workerUrl: 'http://worker-copy:3000', workerReadUrl: 'http://worker-read:3000' } } as never); };
  it('the read worker on the api\'s address: `read-api` (the read meter and the shared one would be one limit); distinct again clears it', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    let readIdentity = identity('read', ['34.1.2.3']);
    const copyIdentity = identity('copy', ['208.77.246.240']);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => ({ ok: true, json: async () => new URL(String(input)).hostname === 'worker-read' ? sample('read', readIdentity) : sample('copy', copyIdentity) })));
    const api = new EgressIdentityMonitor(vi.fn(async () => new Response('152.55.188.100\n')) as unknown as typeof fetch, () => clock.now)
      .configure({ role: 'api', egressKey: 'stage-egress', config: { mode: 'observe', echoUrls: ['https://api.ipify.org'], timeoutMs: 3000, intervalMs: 300_000 } });
    await api.observe();
    const service = new WorkerFleetService(config(), () => clock.now, api);
    expect(await service.check()).toEqual([]);
    readIdentity = identity('read', ['152.55.188.100']);
    clock.now += 1000;
    // (lastOkAt: the copy worker's probe of the same poll still found no pair.)
    expect(await service.check()).toEqual([{ code: 'egress_identity_shared', lastOkAt: new Date(clock.now).toISOString(), ips: ['152.55.188.100'], peers: ['api', 'read'], pairs: ['read-api'] }]);
    // The admin overview carries the pair.
    const repository = { probe: vi.fn().mockResolvedValue(3), data: vi.fn().mockResolvedValue(null), outbox: vi.fn().mockResolvedValue([]), retention: vi.fn().mockResolvedValue(null) };
    const budget = { requestsLastMinute: 1, weightLastMinute: 20, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null };
    const overview = adminSystemSchema.parse(await new AdminSystemService(repository as never, config(), { introspect: () => budget, queued: () => ({ live: 0, background: 0 }) } as never, service).overview());
    expect(overview.alerts?.map(a => [a.code, a.pairs])).toEqual([['egress_identity_shared', ['read-api']]]);
    readIdentity = identity('read', ['34.1.2.3']);
    clock.now += 1000;
    expect(await service.check()).toEqual([]);
  });
});

describe('both meters are shown', () => {
  it('the worker heartbeat names its meter, cap and reserve', async () => {
    const config = testConfig(), budgeter = new RequestBudgeterService(config);
    const watcher = { getHeartbeat: () => ({ feed: { socketsTotal: 1, socketsOpen: 1, markets: 1, disconnectedSince: null, lastTradeAt: null }, lastFillAt: null, lastSweepAt: null, fillsUnavailable: [] }) };
    const scheduler = { lastSnapshotAt: null, lastSnapshotAttemptAt: null, lastSnapshotFailureAt: null };
    const readConfig = new AppConfig({ ...config.value, hyperliquid: { ...config.value.hyperliquid, meter: 'read', egressKey: 'stage-egress:read', sharedEgressKey: 'stage-egress', backgroundRestCap: READ_WORKER_BACKGROUND_REST_CAP } } as never);
    try {
      const copy = await new WorkerHeartbeatService(config, watcher as never, scheduler as never, budgeter).heartbeat();
      expect(heartbeatResponseSchema.parse(copy).meter).toEqual({ meter: 'copy', egressKey: config.value.hyperliquid.egressKey ?? null, backgroundCap: config.value.hyperliquid.backgroundRestCap, reserved: HYPERLIQUID_REST_CAP - config.value.hyperliquid.backgroundRestCap });
      const own = await new WorkerHeartbeatService(readConfig, watcher as never, scheduler as never, budgeter).heartbeat();
      expect(heartbeatResponseSchema.parse(own).meter).toEqual({ meter: 'read', egressKey: 'stage-egress:read', backgroundCap: 900, reserved: 300 });
    } finally { budgeter.onModuleDestroy(); }
  });
  it('the admin overview reads both meter rows: the copy side\'s and `<key>:read`, each with its cap', async () => {
    const b = testConfig().value;
    const config = new AppConfig({ ...b, hyperliquid: { ...b.hyperliquid, egressKey: 'stage-egress', sharedEgressKey: 'stage-egress', backgroundRestCap: 400 } } as never);
    const snapshot = (background: number, page: number): HyperliquidMeterSnapshot => ({ wsConnect: 0, wsMessages: 0, leases: 0,
      rest: { total: background + page + 1, background, other: 0, live: 0, page, source: 0, setup: {}, markers: { setup: 0, live: 1, source: 0 }, pending: [], granted: [], liveNeed: 0, liveKinds: {}, sources: {} } });
    const quota = { meterSnapshot: vi.fn(async (key: string) => key === 'stage-egress:read' ? snapshot(850, 40) : snapshot(300, 120)) };
    const repository = { probe: vi.fn().mockResolvedValue(3), data: vi.fn().mockResolvedValue(null), outbox: vi.fn().mockResolvedValue([]), retention: vi.fn().mockResolvedValue(null) };
    const budget = { requestsLastMinute: 1, weightLastMinute: 20, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null };
    const overview = adminSystemSchema.parse(await new AdminSystemService(repository as never, config, { introspect: () => budget, queued: () => ({ live: 0, background: 0 }) } as never, new WorkerFleetService(config), undefined, quota).overview());
    expect(quota.meterSnapshot.mock.calls.map(c => c[0])).toEqual(['stage-egress', 'stage-egress:read']);
    expect(overview.api.meters).toEqual([
      { meter: 'copy', egressKey: 'stage-egress', backgroundCap: 400, reserved: 800, rest: { total: 421, background: 300, page: 120, live: 0, source: 0, setup: 0, other: 0, markers: 1 } },
      { meter: 'read', egressKey: 'stage-egress:read', backgroundCap: 900, reserved: 300, rest: { total: 891, background: 850, page: 40, live: 0, source: 0, setup: 0, other: 0, markers: 1 } },
    ]);
    // A meter whose row cannot be read is left out; the overview still answers.
    quota.meterSnapshot.mockImplementation(async (key: string) => { if (key.endsWith(':read')) throw new Error('down'); return snapshot(1, 1); });
    const partial = adminSystemSchema.parse(await new AdminSystemService(repository as never, config, { introspect: () => budget, queued: () => ({ live: 0, background: 0 }) } as never, new WorkerFleetService(config), undefined, quota).overview());
    expect(partial.api.meters?.map(m => m.meter)).toEqual(['copy']);
  });
});
