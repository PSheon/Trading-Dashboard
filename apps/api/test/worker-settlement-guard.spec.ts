import { Logger } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminSystemSchema } from '@trading-dashboard/shared/contracts';
import { AdminSystemService } from '../src/admin/admin-system.service.js';
import { WorkerFleetService } from '../src/api/health/worker-fleet.service.js';
import { AppConfig } from '../src/config/app-config.js';
import { validateEnvironment } from '../src/config/runtime-config.js';
import type { CopyLiveEngine } from '../src/copy/live-worker/copy-live-engine.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import type { WorkerRole } from '../src/runtime/worker-role.js';
import { WorkerHeartbeatService } from '../src/worker/worker-heartbeat.service.js';
import { testConfig } from './config-test-utils.js';
import { ALERT_EVERY_MS } from '../src/config/constants/alerts.js';
import { SETTLEMENT_OWNER_WINDOW_MS } from '../src/config/constants/alerts.js';

// D13 (2026-10-23): terminal settlement runs only on the copy worker, inside
// its live engine. The api has no settlement loop and no switch for one; it
// watches the copy worker's heartbeat (worker.terminalSettlement) and alerts
// when no copy worker reports its engine running for SETTLEMENT_OWNER_WINDOW_MS.
const T0 = 1_792_000_000_000;
const live = { network: 'testnet', caps: { maxStrategiesPerUser: 1 }, builderFee: true, intervalMs: 3000, testnetSourceIntervalMs: 60000, maxSourceDeviationBps: 500, slippageBps: 30, weightPerMin: 400 };
function configOf({ isWorker = false, role = 'all' as WorkerRole, liveCopy = true, noWorker = false } = {}) {
  const base = testConfig().value;
  return new AppConfig({ ...base, app: { ...base.app, isWorker, workerRole: role, workerUrl: noWorker ? undefined : 'http://worker-copy:3000' },
    copy: { ...base.copy, live: liveCopy ? live : undefined } } as never);
}
/** A worker's monitor sample whose heartbeat reports `worker`. */
const sample = (at: number, worker?: { role: WorkerRole; leases: number[]; terminalSettlement?: boolean }) => ({
  state: 'active', instanceId: 'w-1', sampledAt: new Date(at).toISOString(), uptimeSeconds: 60,
  budget: { requestsLastMinute: 0, weightLastMinute: 0, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null, queued: { live: 0, background: 0 } },
  heartbeat: { feedConnected: true, feedSocketsOpen: 1, feedSocketsTotal: 1, marketsSubscribed: 1, feedDisconnectedSince: null, lastTradeAt: null, lastFillAt: null,
    lastSnapshotAt: null, lastSweepAt: null, requestsLastMinute: 0, weightLastMinute: 0, queuedRequests: { live: 0, background: 0 }, fillsUnavailable: [], dryRun: true,
    ...(worker ? { worker } : {}), now: new Date(at).toISOString() },
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('the worker heartbeat reports whether it settles terminal copies (its live engine runs)', () => {
  async function beat(config: AppConfig, engine: CopyLiveEngine | null | undefined) {
    const budgeter = new RequestBudgeterService(config);
    const watcher = { getHeartbeat: () => ({ feed: { socketsTotal: 1, socketsOpen: 1, markets: 1, disconnectedSince: null, lastTradeAt: null }, lastFillAt: null, lastSweepAt: null, fillsUnavailable: [] }) };
    try { return (await new WorkerHeartbeatService(config, watcher as never, null, budgeter, undefined, undefined, undefined, undefined, engine).heartbeat()).worker; }
    finally { budgeter.onModuleDestroy(); }
  }
  it('a copy or `all` worker with a live engine says true; one whose engine is off (paper copy) or absent (a read worker) says false', async () => {
    const engine = {} as CopyLiveEngine;
    expect(await beat(configOf({ isWorker: true, role: 'copy' }), engine)).toEqual({ role: 'copy', leases: [1], terminalSettlement: true });
    expect(await beat(configOf({ isWorker: true, role: 'all' }), engine)).toEqual({ role: 'all', leases: [1, 2], terminalSettlement: true });
    expect(await beat(configOf({ isWorker: true, role: 'copy', liveCopy: false }), null)).toMatchObject({ terminalSettlement: false });
    expect(await beat(configOf({ isWorker: true, role: 'read' }), undefined)).toEqual({ role: 'read', leases: [2], terminalSettlement: false });
  });
});

describe('the api process runs no terminal settlement', () => {
  it('its module graph has no settlement provider, and its environment has no switch for one', async () => {
    vi.stubEnv('DATABASE_URL', process.env.TEST_DATABASE_URL!);
    const config = new AppConfig(validateEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL!, WORKER_URL: 'http://worker.internal:3000', API_TERMINAL_SETTLEMENT: 'off' }));
    expect(config.value.app.isWorker).toBe(false);
    expect(config.value.app).not.toHaveProperty('terminalSettlement');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ feedConnected: true }) }));
    const { AppModule } = await import('../src/app.module.js');
    const ref = await Test.createTestingModule({ imports: [AppModule.api()] }).overrideProvider(AppConfig).useValue(config).compile();
    const app = ref.createNestApplication({ logger: false });
    try {
      await app.init();
      const names = new Set<string>();
      for (const module of app.get(ModulesContainer).values()) for (const wrapper of module.providers.values()) if (typeof wrapper.name === 'string') names.add(wrapper.name);
      // No provider settles, claims settlement work or runs a settlement loop in the api (the engine and its settler are the copy worker's).
      expect([...names].filter(name => /Settl|LiveEngine|LIVE_ENGINE/i.test(name))).toEqual([]);
      // The api's switches no longer carry one.
      expect(app.get(WorkerFleetService).settlementGuardApplies()).toBe(false);
    } finally { await app.close(); }
  });
});

describe('the api alerts when no copy worker settles terminal copies (WorkerFleetService)', () => {
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

  it('no copy worker reports its engine running for 2 minutes: an ALERT, rate-limited, and the admin overview shows it', async () => {
    clock.now = T0;
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // The worker reads as an `all` worker whose engine is off (paper copy).
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
    expect(alerts(error)[0]).toMatch(/^ALERT terminal_settlement_unowned .*no copy worker heartbeat/);
    expect(alerts(error)[0]).not.toContain('API_TERMINAL_SETTLEMENT');
    // Rate-limited: once per ALERT_EVERY_MS while it lasts.
    later(60_000); await service.check();
    expect(alerts(error)).toHaveLength(1);
    later(ALERT_EVERY_MS); await service.check();
    expect(alerts(error)).toHaveLength(2);
    // The admin overview shows it.
    const repository = { probe: vi.fn().mockResolvedValue(3), data: vi.fn().mockResolvedValue(null), outbox: vi.fn().mockResolvedValue([]), retention: vi.fn().mockResolvedValue(null) };
    const budget = { requestsLastMinute: 1, weightLastMinute: 20, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null };
    const overview = () => new AdminSystemService(repository as never, configOf(), { introspect: () => budget, queued: () => ({ live: 0, background: 0 }) } as never, service).overview();
    expect(adminSystemSchema.parse(await overview()).alerts).toEqual([{ code: 'terminal_settlement_unowned', lastOkAt: new Date(T0).toISOString() }]);
    // A copy worker whose engine runs clears it at its next heartbeat.
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

  it('an unreachable worker, a stale sample, a read worker, or a heartbeat without the field never count as settling', async () => {
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

  it('applies to the api of a live copy deployment with a copy worker to watch: not to a worker, paper copy, or an api without WORKER_URL', async () => {
    clock.now = T0;
    const quiet = () => undefined;
    for (const [config, applies] of [[configOf(), true], [configOf({ liveCopy: false }), false], [configOf({ isWorker: true }), false], [configOf({ noWorker: true }), false]] as const) {
      const service = fleet(config, quiet);
      expect(service.settlementGuardApplies()).toBe(applies);
      later(SETTLEMENT_OWNER_WINDOW_MS + 1);
      expect((await service.check()).length).toBe(applies ? 1 : 0);
    }
  });
});
