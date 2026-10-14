import { describe, expect, it, vi } from 'vitest';
import { adminSystemSchema, heartbeatResponseSchema } from '@trading-dashboard/shared/contracts';
import { AdminSystemService } from '../src/admin/admin-system.service.js';
import { WorkerFleetService } from '../src/api/health/worker-fleet.service.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import type { DrizzleDb } from '../src/db/drizzle.provider.js';
import { FOREIGN_USAGE_SHARE, ForeignUsageCounter, foreignUsage, isWsRateLimit } from '../src/hyperliquid/foreign-usage.js';
import { HyperliquidGlobalTransport } from '../src/hyperliquid/hyperliquid-global-transport.js';
import type { HyperliquidMeterComposition } from '../src/hyperliquid/hyperliquid-global-quota.js';
import { PostgresHyperliquidQuota, type HyperliquidMeterSnapshot } from '../src/hyperliquid/postgres-hyperliquid-quota.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { WorkerHeartbeatService } from '../src/worker/worker-heartbeat.service.js';
import { testConfig } from './config-test-utils.js';

// foreign_usage_suspected (design §8 I-12): Hyperliquid answers a REST 429
// (or a WebSocket rate-limit error) while our own shared meter for that
// egress key holds under 80 % of the window: someone else leaves from our IP.
const info = 'https://api.hyperliquid-testnet.xyz/info';
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const composition = (sent: { background?: number; live?: number; page?: number; other?: number; setup?: Record<string, number> }, markers = 0): HyperliquidMeterComposition => ({
  total: 0, background: sent.background ?? 0, other: sent.other ?? 0, live: sent.live ?? 0, page: sent.page ?? 0, setup: sent.setup ?? {},
  markers: { setup: 0, live: markers }, pending: [], granted: [], liveNeed: 0,
});
const snapshot = (rest: HyperliquidMeterComposition, wsMessages = 0): HyperliquidMeterSnapshot => ({ rest, wsConnect: 0, wsMessages, leases: 0 });

function fixture(answer: number, meter: () => HyperliquidMeterSnapshot) {
  const quota = new PostgresHyperliquidQuota(new UnitOfWork({} as DrizzleDb));
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: answer }));
  const acquire = vi.fn(async () => ({ assertFresh: () => {}, dispatch: <T>(work: () => T): T => work() }));
  vi.spyOn(quota, 'bindUnscoped').mockReturnValue({ acquireRest: acquire, reserveSocket: vi.fn() } as never);
  const read = vi.spyOn(quota, 'meterSnapshot').mockImplementation(async () => meter());
  const counter = new ForeignUsageCounter({ warn: vi.fn() });
  const transport = new HyperliquidGlobalTransport(quota, { egressKey: 'stage-A:testnet', ownerId: 'worker-a' }, fetcher, Date.now, async () => {}, counter);
  return { transport, counter, read, fetcher };
}

describe('foreign usage is counted only below 80 % of our own window', () => {
  it('the counter: below the share counts and logs; at or above it, or with no meter reading, only the rate limit is counted', () => {
    const warn = vi.fn(), counter = new ForeignUsageCounter({ warn }, () => 1_792_000_000_000);
    expect(counter.note('stage-A', '429', 0.79)).toBe(true);
    expect(counter.note('stage-A', '429', FOREIGN_USAGE_SHARE)).toBe(false);
    expect(counter.note('stage-A', '429', 0.95)).toBe(false);
    expect(counter.note('stage-A', '429', undefined)).toBe(false);
    expect(counter.status()).toEqual({ rateLimited: 4, count: 1, lastAt: new Date(1_792_000_000_000).toISOString(), lastKey: 'stage-A', lastStatus: '429', lastOurWindowUse: 0.79 });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toBe('foreign_usage_suspected {"key":"stage-A","ourWindowUse":0.79,"status":"429","count":1}');
  });

  it('a REST 429 from an info read while our meter holds 360 of 1200 (30 %): suspected', async () => {
    const f = fixture(429, () => snapshot(composition({ background: 200, live: 100, page: 60 }, 1)));
    const response = await f.transport.fetchInfo(info, post({ type: 'meta' }));
    expect(response.status).toBe(429);
    await vi.waitFor(() => expect(f.counter.status().count).toBe(1));
    expect(f.read).toHaveBeenCalledWith('stage-A:testnet');
    expect(f.counter.status()).toMatchObject({ rateLimited: 1, lastKey: 'stage-A:testnet', lastStatus: '429', lastOurWindowUse: 0.3 });
  });

  it('a 429 while our own charges fill 1000 of 1200 (83 %): ours, not counted', async () => {
    const f = fixture(429, () => snapshot(composition({ background: 700, live: 200, setup: { abcd1234: 100 } })));
    await f.transport.fetchBackgroundInfo(info, post({ type: 'meta' }));
    await vi.waitFor(() => expect(f.counter.status().rateLimited).toBe(1));
    expect(f.counter.status().count).toBe(0);
  });

  it('an exchange POST and a batch are watched too; a 200 reads nothing', async () => {
    const f = fixture(429, () => snapshot(composition({})));
    const permit = await f.transport.acquireExchange(Date.now() + 4000);
    expect((await permit.dispatch(() => f.fetcher('https://api.hyperliquid-testnet.xyz/exchange'))).status).toBe(429);
    await vi.waitFor(() => expect(f.counter.status().count).toBe(1));
    await f.transport.fetchInfoBatch(info, [{ type: 'meta' }, { type: 'spotMeta' }], { maxWaitMs: 0 });
    await vi.waitFor(() => expect(f.counter.status().count).toBe(2));
    const ok = fixture(200, () => snapshot(composition({})));
    await ok.transport.fetchInfo(info, post({ type: 'meta' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ok.read).not.toHaveBeenCalled();
    expect(ok.counter.status().rateLimited).toBe(0);
  });

  it('a WebSocket rate-limit error is measured against our message window', async () => {
    const f = fixture(200, () => snapshot(composition({}), 1500));
    f.transport.noteWsError('Too many messages');
    await vi.waitFor(() => expect(f.counter.status().rateLimited).toBe(1));
    expect(f.counter.status().count).toBe(1);
    expect(f.counter.status()).toMatchObject({ lastStatus: 'ws_rate_limit', lastOurWindowUse: 0.75 });
    f.transport.noteWsError('Invalid subscription');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.counter.status().rateLimited).toBe(1);
    expect(isWsRateLimit({ error: 'rate limited' })).toBe(true);
  });
});

describe('the heartbeat and the admin overview show the count and the last time', () => {
  it('foreignUsage in the worker heartbeat and in the api overview', async () => {
    const config = testConfig(), budgeter = new RequestBudgeterService(config);
    const watcher = { getHeartbeat: () => ({ feed: { socketsTotal: 1, socketsOpen: 1, markets: 1, disconnectedSince: null, lastTradeAt: null }, lastFillAt: null, lastSweepAt: null, fillsUnavailable: [] }) };
    try {
      const before = foreignUsage.status().count;
      foreignUsage.note('stage-A', '429', 0.1);
      const heartbeat = heartbeatResponseSchema.parse(await new WorkerHeartbeatService(config, watcher as never, null, budgeter).heartbeat());
      expect(heartbeat.foreignUsage).toMatchObject({ count: before + 1, lastKey: 'stage-A', lastStatus: '429', lastOurWindowUse: 0.1 });
      expect(heartbeat.foreignUsage?.lastAt).toEqual(expect.any(String));
      const repository = { probe: vi.fn().mockResolvedValue(3), data: vi.fn().mockResolvedValue(null), outbox: vi.fn().mockResolvedValue([]), retention: vi.fn().mockResolvedValue(null) };
      const fleet = { monitors: async () => ({ worker: { state: 'not_configured', sample: null } }), alerts: () => [] } as unknown as WorkerFleetService;
      const overview = adminSystemSchema.parse(await new AdminSystemService(repository as never, config, budgeter, fleet).overview());
      expect(overview.api.foreignUsage).toMatchObject({ count: before + 1, lastKey: 'stage-A' });
    } finally { budgeter.onModuleDestroy(); }
  });
});
