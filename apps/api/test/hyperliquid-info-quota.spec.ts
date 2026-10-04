import { afterEach, expect, it, vi } from 'vitest';
import { HyperliquidInfoClient } from '../src/hyperliquid/hyperliquid-info.client.js';
import type { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { testConfig } from './config-test-utils.js';
import { budgetConsumer, PAGE_RANK } from '../src/hyperliquid/request-budgeter.service.js';
import { HyperliquidRestCapacityError } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { ESSENTIAL_CAPACITY_WAIT_MS, PAGE_CAPACITY_WAIT_MS } from '../src/hyperliquid/hyperliquid-global-transport.js';
import { offlineGlobalTransport } from './hyperliquid-quota-test-utils.js';
afterEach(() => { vi.unstubAllGlobals(); });
const budget = () => ({ acquire: vi.fn(async () => {}), adjust: vi.fn(), onSuccess: vi.fn(), onRateLimited: vi.fn() });
it('requires globally metered transport before any registered INFO request', async () => {
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
  const info = new HyperliquidInfoClient(testConfig(), budget() as unknown as RequestBudgeterService);
  await expect(info.perpDexs()).rejects.toThrow('hyperliquid_quota_egress_unconfigured');
  expect(fetcher).not.toHaveBeenCalled();
});
it('dispatches the provider request under durable global admission in addition to local queue scheduling', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json([null]));
  const q = offlineGlobalTransport(fetcher), local = budget();
  const info = new HyperliquidInfoClient(testConfig(), local as unknown as RequestBudgeterService, undefined, q.transport);
  expect(await info.perpDexs()).toEqual([null]);
  // Background work (no page rank) is held below the shared window.
  expect(q.acquire).toHaveBeenCalledWith(20, expect.any(Number), 'background'); expect(local.acquire).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
});
it('global capacity denial cannot fall back to native fetch or be refunded from the shared meter', async () => {
  const fetcher = vi.fn<typeof fetch>(), q = offlineGlobalTransport(fetcher), local = budget();
  q.acquire.mockRejectedValueOnce(Error('global capacity denied'));
  const info = new HyperliquidInfoClient(testConfig(), local as unknown as RequestBudgeterService, undefined, q.transport);
  await expect(info.userFills('0x' + '12'.repeat(20))).rejects.toThrow('global capacity denied'); expect(fetcher).not.toHaveBeenCalled();
  expect(q.acquire).toHaveBeenCalledWith(120, expect.any(Number), 'background'); expect(q.acquire).toHaveBeenCalledOnce();
});
it('preserves aggregate metadata venue slots and never substitutes a per-venue REST scan', async () => {
  const metadata = [{ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] }, null,
    { universe: [{ name: 'xyz:INTC', szDecimals: 2, maxLeverage: 10 }], collateralToken: 0 }];
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(metadata)), q = offlineGlobalTransport(fetcher);
  const info = new HyperliquidInfoClient(testConfig(), budget() as unknown as RequestBudgeterService, undefined, q.transport);
  expect(await info.allPerpMetas('live')).toEqual(metadata); expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ type: 'allPerpMetas' });
});
it('sends page work and live work in the unlabelled lane, background work in the capped one', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json([null])), q = offlineGlobalTransport(fetcher);
  const info = new HyperliquidInfoClient(testConfig(), budget() as unknown as RequestBudgeterService, undefined, q.transport);
  await info.perpDexs('background', PAGE_RANK.profile);
  await info.perpDexs('live');
  await info.perpDexs('background', PAGE_RANK.warm);
  await info.perpDexs('background', 1_000);
  expect(q.acquire.mock.calls.map((call) => (call as unknown[])[2])).toEqual([undefined, undefined, 'background', 'background']);
});
it('a page call waits for shared capacity to free instead of answering busy at once; background work does not', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json([null])), q = offlineGlobalTransport(fetcher);
  const info = new HyperliquidInfoClient(testConfig(), budget() as unknown as RequestBudgeterService, undefined, q.transport);
  q.acquire.mockRejectedValueOnce(new HyperliquidRestCapacityError(50));
  expect(await info.perpDexs('background', PAGE_RANK.profile)).toEqual([null]);
  expect(q.acquire).toHaveBeenCalledTimes(2); expect(fetcher).toHaveBeenCalledOnce();
  q.acquire.mockRejectedValueOnce(new HyperliquidRestCapacityError(50));
  await expect(info.perpDexs('background', 1_000)).rejects.toThrow('hyperliquid_quota_exhausted');
  expect(q.acquire).toHaveBeenCalledTimes(3); expect(fetcher).toHaveBeenCalledOnce();
  // Not past the wait bound: a release further away than that answers busy.
  q.acquire.mockRejectedValueOnce(new HyperliquidRestCapacityError(PAGE_CAPACITY_WAIT_MS + 1));
  await expect(info.perpDexs('background', PAGE_RANK.profile)).rejects.toThrow('hyperliquid_quota_exhausted');
});
it('snapshots and sweeps of watched leaders wait for room in the background lane; the pool and history loops do not', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json([null])), q = offlineGlobalTransport(fetcher);
  const info = new HyperliquidInfoClient(testConfig(), budget() as unknown as RequestBudgeterService, undefined, q.transport);
  for (const consumer of ['sweep', 'snapshots']) {
    q.acquire.mockRejectedValueOnce(new HyperliquidRestCapacityError(50));
    expect(await budgetConsumer(consumer, () => info.perpDexs('background'))).toEqual([null]);
  }
  expect(q.acquire.mock.calls.map((call) => (call as unknown[])[2])).toEqual(['background', 'background', 'background', 'background']);
  expect(fetcher).toHaveBeenCalledTimes(2);
  // Not past its own bound (longer than a page's).
  expect(ESSENTIAL_CAPACITY_WAIT_MS).toBeGreaterThan(PAGE_CAPACITY_WAIT_MS);
  q.acquire.mockRejectedValueOnce(new HyperliquidRestCapacityError(ESSENTIAL_CAPACITY_WAIT_MS + 1));
  await expect(budgetConsumer('sweep', () => info.perpDexs('background'))).rejects.toThrow('hyperliquid_quota_exhausted');
  for (const consumer of ['pool.performance', 'pool.ledgers', 'history', 'tracked']) {
    q.acquire.mockRejectedValueOnce(new HyperliquidRestCapacityError(50));
    await expect(budgetConsumer(consumer, () => info.perpDexs('background'))).rejects.toThrow('hyperliquid_quota_exhausted');
  }
});
