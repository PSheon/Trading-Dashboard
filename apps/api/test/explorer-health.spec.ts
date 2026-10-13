import { afterEach, expect, it, vi } from 'vitest';
import { heartbeatResponseSchema, wireHeartbeatSchema } from '@trading-dashboard/shared/contracts';
import { CopyFundingExchangeClient } from '../src/copy/copy-funding-exchange.client.js';
import { explorerHealth } from '../src/copy/explorer-health.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { WorkerHeartbeatService } from '../src/worker/worker-heartbeat.service.js';
import { testConfig } from './config-test-utils.js';

// The worker's heartbeat reports whether its explorer reads (a deposit's
// proof of credit) reach Hyperliquid, and since when they have not.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); explorerHealth.reachable(); });

function heartbeat() {
  const config = testConfig(), budgeter = new RequestBudgeterService(config);
  const watcher = { getHeartbeat: () => ({ feed: { socketsTotal: 1, socketsOpen: 1, markets: 1, disconnectedSince: null, lastTradeAt: null }, lastFillAt: null, lastSweepAt: null, fillsUnavailable: [] }) };
  const scheduler = { lastSnapshotAt: null, lastSnapshotAttemptAt: null, lastSnapshotFailureAt: null };
  const service = new WorkerHeartbeatService(config, watcher as never, scheduler as never, budgeter);
  return { read: async () => { try { return await service.heartbeat(); } finally { budgeter.onModuleDestroy(); } } };
}
function explorer() {
  const budget = { acquire: vi.fn(async () => {}), liveCapacity: 1000, liveWaitMs: () => 0, refillMs: () => 0 };
  return new CopyFundingExchangeClient(budget as unknown as RequestBudgeterService);
}
const hash = `0x${'aa'.repeat(32)}`;
const dnsFailure = () => new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });

it('the heartbeat carries explorerReachable and explorerFailingSince: the first of an outage, until a read answers', async () => {
  expect(await heartbeat().read()).toMatchObject({ explorerReachable: true, explorerFailingSince: null });
  vi.stubGlobal('fetch', vi.fn(async () => { throw dnsFailure(); }));
  const first = 1_791_800_000_000, clock = vi.spyOn(Date, 'now').mockReturnValue(first);
  await expect(explorer().txDetails('testnet', hash)).rejects.toMatchObject({ code: 'funding_explorer_unreachable' });
  clock.mockReturnValue(first + 60_000);
  await expect(explorer().txDetails('testnet', hash)).rejects.toMatchObject({ code: 'funding_explorer_unreachable' });
  clock.mockRestore();
  const down = await heartbeat().read();
  expect(down).toMatchObject({ explorerReachable: false, explorerFailingSince: new Date(first) });
  // The schema the api serves and the web reads, as JSON.
  expect(heartbeatResponseSchema.parse(down)).toMatchObject({ explorerReachable: false, explorerFailingSince: new Date(first) });
  expect(wireHeartbeatSchema.parse(JSON.parse(JSON.stringify(down)))).toMatchObject({ explorerReachable: false, explorerFailingSince: new Date(first).toISOString() });
  // A failure that is not the network (an HTTP answer) leaves the outage as it is; an answer ends it.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
  await expect(explorer().txDetails('testnet', hash)).rejects.toThrow('Funding evidence unavailable');
  expect(await heartbeat().read()).toMatchObject({ explorerReachable: false, explorerFailingSince: new Date(first) });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'txDetails', tx: {} })));
  await explorer().txDetails('testnet', hash);
  expect(await heartbeat().read()).toMatchObject({ explorerReachable: true, explorerFailingSince: null });
});
