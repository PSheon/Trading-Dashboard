import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import * as schema from '@trading-dashboard/shared/database';
import { adminSystemSchema, heartbeatResponseSchema, wireHeartbeatSchema } from '@trading-dashboard/shared/contracts';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { AdminSystemService } from '../src/admin/admin-system.service.js';
import { AppConfig } from '../src/config/app-config.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { PostgresHyperliquidQuota } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { WorkerHeartbeatService } from '../src/worker/worker-heartbeat.service.js';
import { testConfig } from './config-test-utils.js';
import { closeTestDb, getTestDb } from './db-test-utils.js';

// The worker's heartbeat and the admin system overview show the shared
// meter's setup and live lanes: a setup waiting for room, a live order's
// need kept ahead of setups and background (count, what the lane holds,
// until when).
let db: ReturnType<typeof getTestDb>, pool: Pool;
beforeAll(() => { db = getTestDb(); pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
afterAll(async () => { await pool.end(); await closeTestDb(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function meter() {
  const egressKey = `lanes-${randomUUID()}`;
  const transport = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey, ownerId: 'worker' }, async () => Response.json({}));
  // A setup claims its mode step and charges 102 of it; a live order announces 589 and charges 300.
  const setup = randomUUID(), claimedAt = Date.now();
  await transport.claimSetup(613, setup);
  await transport.runSetup(async () => { (await transport.currentQuota().acquireRest(102, Date.now() + 5000)).dispatch(() => undefined); }, setup);
  const token = await transport.claimLive(589, Date.now() + 5000);
  await transport.runLive(token!, async () => { (await transport.currentQuota().acquireRest(300, Date.now() + 5000)).dispatch(() => undefined); });
  return { egressKey, transport, claimedAt, cleanup: () => db.delete(schema.hyperliquidEgressQuota).where(eq(schema.hyperliquidEgressQuota.egressKey, egressKey)) };
}

it('the worker heartbeat carries setupDemand and liveDemand from the shared meter', async () => {
  const { transport, claimedAt, cleanup } = await meter();
  try {
    const config = testConfig(), budgeter = new RequestBudgeterService(config);
    const watcher = { getHeartbeat: () => ({ feed: { socketsTotal: 1, socketsOpen: 1, markets: 1, disconnectedSince: null, lastTradeAt: null }, lastFillAt: null, lastSweepAt: null, fillsUnavailable: [] }) };
    const scheduler = { lastSnapshotAt: null, lastSnapshotAttemptAt: null, lastSnapshotFailureAt: null };
    const service = new WorkerHeartbeatService(config, watcher as never, scheduler as never, budgeter, undefined, undefined, { transport } as never);
    let beat: Awaited<ReturnType<WorkerHeartbeatService['heartbeat']>>;
    try { beat = await service.heartbeat(); } finally { budgeter.onModuleDestroy(); }
    expect(beat.setupDemand).toMatchObject({ count: 1, held: 102 });
    expect(beat.setupDemand!.until!.getTime()).toBeGreaterThan(claimedAt + 60_000);
    expect(beat.liveDemand).toMatchObject({ count: 1, held: 300 });
    expect(beat.liveDemand!.until!.getTime()).toBeGreaterThan(claimedAt + 10_000);
    expect(beat.liveDemand!.until!.getTime()).toBeLessThanOrEqual(Date.now() + 15_000);
    // Both contracts accept them (optional: an older worker sends neither).
    expect(heartbeatResponseSchema.parse(beat).liveDemand?.held).toBe(300);
    const wire = wireHeartbeatSchema.parse(JSON.parse(JSON.stringify(beat)));
    expect(wire.setupDemand).toMatchObject({ count: 1, held: 102, until: beat.setupDemand!.until!.toISOString() });
    const { setupDemand: _s, liveDemand: _l, ...older } = JSON.parse(JSON.stringify(beat));
    expect(wireHeartbeatSchema.parse(older).setupDemand).toBeUndefined();
  } finally { await cleanup(); }
});

it('the admin system overview shows the api process\'s view of both lanes; none while nothing is alive', async () => {
  const { transport, cleanup } = await meter();
  try {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const budget = { requestsLastMinute: 1, weightLastMinute: 20, effectiveBudgetPerMin: 240, configuredBudgetPerMin: 240, burstCapacity: 100, tokensAvailable: 80, lastRateLimitedAt: null };
    const repository = { probe: vi.fn().mockResolvedValue(3), data: vi.fn().mockRejectedValue(new Error('x')), outbox: vi.fn().mockResolvedValue([]), retention: vi.fn().mockRejectedValue(new Error('x')) };
    const config = new AppConfig({ ...testConfig().value, app: { ...testConfig().value.app, isWorker: false, workerUrl: undefined } });
    const overview = (wallet?: unknown) => new AdminSystemService(repository as never, config, { introspect: () => budget, queued: () => ({ live: 0, background: 0 }) } as never, wallet as never).overview();
    const api = adminSystemSchema.parse(await overview({ transport })).api;
    expect(api.setupDemand).toMatchObject({ count: 1, held: 102 });
    expect(api.liveDemand).toMatchObject({ count: 1, held: 300 });
    expect(Date.parse(api.liveDemand!.until!)).toBeGreaterThan(Date.now());
    // An empty meter: nothing alive, nothing held.
    const empty = new HyperliquidGlobalTransport(new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema }))), { egressKey: `lanes-${randomUUID()}`, ownerId: 'api' });
    expect(adminSystemSchema.parse(await overview({ transport: empty })).api.liveDemand).toEqual({ count: 0, held: 0, until: null });
    // Without the wallet network (or an older api), the fields are absent and still valid.
    expect(adminSystemSchema.parse(await overview()).api.setupDemand).toBeUndefined();
  } finally { await cleanup(); }
});

it('the meter snapshot (an absence proof\'s failure log) shows the REST composition, socket units and counted leases', async () => {
  const { transport, cleanup, egressKey } = await meter();
  try {
    const reserved = await transport.currentQuota().reserveSocket(Date.now() + 5000, 'testnet');
    const snapshot = await transport.meterSnapshot();
    expect(snapshot).toMatchObject({ wsConnect: 1, wsMessages: 0, leases: 1, rest: { live: 300, markers: { setup: 1, live: 1 } } });
    expect(Object.values(snapshot!.rest.setup)).toEqual([102]);
    await reserved.connection.cancelBeforeConnect();
    expect((await transport.meterSnapshot())!.leases).toBe(0);
    await db.delete(schema.hyperliquidWsLeases).where(eq(schema.hyperliquidWsLeases.egressKey, egressKey));
  } finally { await cleanup(); }
});
