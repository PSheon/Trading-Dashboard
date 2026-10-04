import { afterEach, expect, it, vi } from 'vitest';
import { HyperliquidInfoClient } from '../src/hyperliquid/hyperliquid-info.client.js';
import type { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { testConfig } from './config-test-utils.js';
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
  expect(q.acquire).toHaveBeenCalledWith(20, expect.any(Number)); expect(local.acquire).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
});
it('global capacity denial cannot fall back to native fetch or be refunded from the shared meter', async () => {
  const fetcher = vi.fn<typeof fetch>(), q = offlineGlobalTransport(fetcher), local = budget();
  q.acquire.mockRejectedValueOnce(Error('global capacity denied'));
  const info = new HyperliquidInfoClient(testConfig(), local as unknown as RequestBudgeterService, undefined, q.transport);
  await expect(info.userFills('0x' + '12'.repeat(20))).rejects.toThrow('global capacity denied'); expect(fetcher).not.toHaveBeenCalled();
  expect(q.acquire).toHaveBeenCalledWith(120, expect.any(Number)); expect(q.acquire).toHaveBeenCalledOnce();
});
it('preserves aggregate metadata venue slots and never substitutes a per-venue REST scan', async () => {
  const metadata = [{ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] }, null,
    { universe: [{ name: 'xyz:INTC', szDecimals: 2, maxLeverage: 10 }], collateralToken: 0 }];
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(metadata)), q = offlineGlobalTransport(fetcher);
  const info = new HyperliquidInfoClient(testConfig(), budget() as unknown as RequestBudgeterService, undefined, q.transport);
  expect(await info.allPerpMetas('live')).toEqual(metadata); expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ type: 'allPerpMetas' });
});
