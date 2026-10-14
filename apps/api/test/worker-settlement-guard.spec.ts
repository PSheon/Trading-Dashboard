import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminSystemSchema } from '@trading-dashboard/shared/contracts';
import { AdminSystemService } from '../src/admin/admin-system.service.js';
import { SETTLEMENT_OWNER_WINDOW_MS, WORKER_ALERT_EVERY_MS, WorkerFleetService } from '../src/api/health/worker-fleet.service.js';
import { AppConfig } from '../src/config/app-config.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import type { WorkerRole } from '../src/runtime/worker-role.js';
import { WorkerHeartbeatService } from '../src/worker/worker-heartbeat.service.js';
import { testConfig } from './config-test-utils.js';

// Cross-process settlement guard: with the api's terminal settlement loop
// off (API_TERMINAL_SETTLEMENT=off) on a testnet copy deployment, a copy
// worker must report its loop on, or the api alerts.
const T0 = 1_792_000_000_000;
const live = { network: 'testnet', caps: { maxStrategiesPerUser: 1 }, builderFee: true, intervalMs: 3000, testnetSourceIntervalMs: 60000, maxSourceDeviationBps: 500, slippageBps: 30, weightPerMin: 400 };
function configOf({ isWorker = false, role = 'all' as WorkerRole, api = false, worker = false, testnet = true } = {}) {
  const base = testConfig().value;
  return new AppConfig({ ...base, app: { ...base.app, isWorker, workerRole: role, workerUrl: 'http://worker-copy:3000', terminalSettlement: { api, worker } },
    copy: { ...base.copy, live: testnet ? live : undefined } } as never);
}
/** A worker's monitor sample whose heartbeat reports `worker`. */
const sample = (at: number, worker?: { role: WorkerRole; leases: number[]; terminalSettlement?: boolean }) => ({
  state: 'active', instanceId: 'w-1', sampledAt: new Date(at).toISOString(), uptimeSeconds: 60,
  budget: { requestsLastMinute: 0, weightLastMinute: 0, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null, queued: { live: 0, background: 0 } },
  heartbeat: { feedConnected: true, feedSocketsOpen: 1, feedSocketsTotal: 1, marketsSubscribed: 1, feedDisconnectedSince: null, lastTradeAt: null, lastFillAt: null,
    lastSnapshotAt: null, lastSweepAt: null, requestsLastMinute: 0, weightLastMinute: 0, queuedRequests: { live: 0, background: 0 }, fillsUnavailable: [], dryRun: true,
    ...(worker ? { worker } : {}), now: new Date(at).toISOString() },
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the worker heartbeat reports whether it runs the terminal settlement loop', () => {
  async function beat(config: AppConfig) {
    const budgeter = new RequestBudgeterService(config);
    const watcher = { getHeartbeat: () => ({ feed: { socketsTotal: 1, socketsOpen: 1, markets: 1, disconnectedSince: null, lastTradeAt: null }, lastFillAt: null, lastSweepAt: null, fillsUnavailable: [] }) };
    try { return (await new WorkerHeartbeatService(config, watcher as never, null, budgeter).heartbeat()).worker; }
    finally { budgeter.onModuleDestroy(); }
  }
  it('a copy worker with WORKER_TERMINAL_SETTLEMENT in effect says on; `all` (off by default), a read worker and a mainnet deployment say off', async () => {
    expect(await beat(configOf({ isWorker: true, role: 'copy', worker: true }))).toEqual({ role: 'copy', leases: [1], terminalSettlement: true });
    expect(await beat(configOf({ isWorker: true, role: 'all', worker: false }))).toEqual({ role: 'all', leases: [1, 2], terminalSettlement: false });
    expect(await beat(configOf({ isWorker: true, role: 'read', worker: false }))).toMatchObject({ terminalSettlement: false });
    expect(await beat(configOf({ isWorker: true, role: 'copy', worker: true, testnet: false }))).toMatchObject({ terminalSettlement: false });
  });
});

describe('the api alerts when no process settles terminal copies (WorkerFleetService)', () => {
  function fleet(config = configOf(), monitor: () => unknown = () => sample(clock.now)) {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const body = monitor();
      return body === undefined ? { ok: false } : { ok: true, json: async () => body };
    }));
    return new WorkerFleetService(config, () => clock.now);
  }
  const clock = { now: T0 };
  const later = (ms: number) => { clock.now += ms; };
  const alerts = (logged: { mock: { calls: unknown[][] } }) => logged.mock.calls.map(c => String(c[0])).filter(line => line.startsWith('ALERT'));

  it('API_TERMINAL_SETTLEMENT=off and no copy worker reports its loop on for 2 minutes: an ALERT, rate-limited, and the admin overview shows it', async () => {
    clock.now = T0;
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // The worker reads as an `all` worker with its loop off (today's default).
    let worker: { role: WorkerRole; leases: number[]; terminalSettlement?: boolean } = { role: 'all', leases: [1, 2], terminalSettlement: false };
    const service = fleet(configOf(), () => sample(clock.now, worker));
    expect(service.settlementGuardApplies()).toBe(true);
    // The api's start counts as fine: a full window first.
    expect(await service.check()).toEqual([]);
    later(SETTLEMENT_OWNER_WINDOW_MS);
    expect(await service.check()).toEqual([]);
    later(1000);
    expect(await service.check()).toEqual([{ code: 'terminal_settlement_unowned', lastOkAt: new Date(T0).toISOString() }]);
    expect(alerts(error)).toHaveLength(1);
    expect(alerts(error)[0]).toMatch(/^ALERT terminal_settlement_unowned .*API_TERMINAL_SETTLEMENT=off/);
    // Rate-limited: once per WORKER_ALERT_EVERY_MS while it lasts.
    later(60_000); await service.check();
    expect(alerts(error)).toHaveLength(1);
    later(WORKER_ALERT_EVERY_MS); await service.check();
    expect(alerts(error)).toHaveLength(2);
    // The admin overview shows it.
    const repository = { probe: vi.fn().mockResolvedValue(3), data: vi.fn().mockResolvedValue(null), outbox: vi.fn().mockResolvedValue([]), retention: vi.fn().mockResolvedValue(null) };
    const budget = { requestsLastMinute: 1, weightLastMinute: 20, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null };
    const overview = () => new AdminSystemService(repository as never, configOf(), { introspect: () => budget, queued: () => ({ live: 0, background: 0 }) } as never, service).overview();
    expect(adminSystemSchema.parse(await overview()).alerts).toEqual([{ code: 'terminal_settlement_unowned', lastOkAt: new Date(T0).toISOString() }]);
    // A copy worker with its loop on (as WORKER_ROLE=copy defaults to) clears it at its next heartbeat.
    worker = { role: 'copy', leases: [1], terminalSettlement: true };
    later(1000);
    expect(await service.check()).toEqual([]);
    expect(log.mock.calls.map(c => String(c[0]))).toContain('terminal_settlement_unowned resolved');
    expect(adminSystemSchema.parse(await overview()).alerts).toEqual([]);
    // It stays clear while the copy worker keeps saying so; it goes quiet (a standby, a crash): the window again.
    later(SETTLEMENT_OWNER_WINDOW_MS); expect(await service.check()).toEqual([]);
    const seen = clock.now;
    worker = { role: 'copy', leases: [1], terminalSettlement: false };
    later(SETTLEMENT_OWNER_WINDOW_MS + 1);
    expect(await service.check()).toEqual([{ code: 'terminal_settlement_unowned', lastOkAt: new Date(seen).toISOString() }]);
  });

  it('an unreachable worker, a stale sample, or a read worker never count as the loop running', async () => {
    clock.now = T0;
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let body: unknown;
    const service = fleet(configOf(), () => body);
    later(SETTLEMENT_OWNER_WINDOW_MS + 1);
    for (const next of [undefined, sample(clock.now - 60_000, { role: 'copy', leases: [1], terminalSettlement: true }), sample(clock.now, { role: 'read', leases: [2], terminalSettlement: true }),
      sample(clock.now, { role: 'copy', leases: [1] })]) {
      body = next;
      expect((await service.check()).map(a => a.code)).toEqual(['terminal_settlement_unowned']);
    }
    // The api's own /health read of the copy worker's heartbeat counts too.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => sample(clock.now, { role: 'copy', leases: [1], terminalSettlement: true }).heartbeat })));
    await service.heartbeat();
    expect(service.alerts()).toEqual([]);
  });

  it('applies only to the api of a testnet copy deployment whose own loop is off', async () => {
    clock.now = T0;
    const quiet = () => undefined;
    for (const [config, applies] of [[configOf(), true], [configOf({ api: true }), false], [configOf({ testnet: false }), false], [configOf({ isWorker: true }), false]] as const) {
      const service = fleet(config, quiet);
      expect(service.settlementGuardApplies()).toBe(applies);
      later(SETTLEMENT_OWNER_WINDOW_MS + 1);
      expect((await service.check()).length).toBe(applies ? 1 : 0);
    }
  });
});
