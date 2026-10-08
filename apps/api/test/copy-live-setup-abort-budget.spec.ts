import 'reflect-metadata';
import type { FactoryProvider } from '@nestjs/common';
import { afterEach, expect, it, vi } from 'vitest';
import { AppConfig } from '../src/config/app-config.js';
import { CopyModule } from '../src/copy/copy.module.js';
import { SETUP_ABORT_OBSERVER } from '../src/copy/copy-live-setup-abort.service.js';
import { CopyFundingExchangeClient } from '../src/copy/copy-funding-exchange.client.js';
import { HyperliquidLiveAccountObserver, HyperliquidAllDexsAccountSource } from '../src/copy/live/live-account-observer.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import type { WalletNetworkHyperliquid } from '../src/hyperliquid/wallet-network-hyperliquid.js';
import { testConfig } from './config-test-utils.js';
import { offlineGlobalTransport } from './hyperliquid-global-test-utils.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const address = `0x${'22'.repeat(20)}`;
function composedObserver(budget: RequestBudgeterService, config: AppConfig) {
  // Native REST/WS endpoints alone are doubles. The registered factory,
  // concrete observer, purpose/full-flat validation and bucket are real.
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const values: Record<string, unknown> = {
      userRole: { role: 'user' }, userAbstraction: 'default', userDexAbstraction: null,
      spotClearinghouseState: { balances: [] }, perpDexs: [null],
      spotMeta: { tokens: [{ index: 7, name: 'USDC', isCanonical: true }] },
      allPerpMetas: [{ collateralToken: 7, universe: [] }],
    };
    if (!(body.type in values)) throw Error('unexpected native read');
    return Response.json(values[body.type]);
  });
  const native = vi.spyOn(HyperliquidAllDexsAccountSource.prototype, 'readAccount').mockImplementation(async user => {
    const at = Date.now(), summary = { accountValue: '49', totalNtlPos: '0', totalRawUsd: '49', totalMarginUsed: '0' };
    return { state: { network: 'testnet', accountAddress: user, observedAt: at, data: { user,
      clearinghouseStates: [['', { marginSummary: summary, crossMarginSummary: summary,
        crossMaintenanceMarginUsed: '0', withdrawable: '49', time: at, assetPositions: [] }]] } },
      orders: { network: 'testnet', accountAddress: user, observedAt: at, completedAt: at, requestedDexes: [''],
        venues: [{ dex: '', user, observedAt: at, receivedAt: at, orders: [] }] } };
  });
  const { transport } = offlineGlobalTransport(fetcher);
  const providers = Reflect.getMetadata('providers', CopyModule) as FactoryProvider[];
  const factory = providers.find(provider => provider.provide === SETUP_ABORT_OBSERVER)!;
  const observer = factory.useFactory({ network: 'testnet', budget, transport, config } as WalletNetworkHyperliquid) as HyperliquidLiveAccountObserver;
  return { observer, fetcher, native };
}

it('the registered abort factory admits two distinct fresh refund proofs from existing live reserve at 400/min with 800 burst', async () => {
  vi.useFakeTimers();
  const c = testConfig().value, config = new AppConfig({ ...c, hyperliquid: { ...c.hyperliquid, budgetPerMin: 400, burst: 800, startupPaceSeconds: 0 } });
  const budget = new RequestBudgeterService(config), { observer, native } = composedObserver(budget, config);
  try {
    const exchangeAdmission = new CopyFundingExchangeClient(budget).acquire();
    await vi.advanceTimersByTimeAsync(0);
    await exchangeAdmission;
    const firstWork = observer.observeSetupAbortFlat(address);
    await vi.advanceTimersByTimeAsync(0);
    const first = await firstWork;
    expect(first).toMatchObject({ purpose: 'setup-abort-return', snapshot: { withdrawable: '49', positions: [], restingOrders: [], coverage: { complete: true, orderComplete: true, balanceComplete: true } } });
    await vi.advanceTimersByTimeAsync(1);
    const started = Date.now();
    let proof: Awaited<ReturnType<typeof observer.observeSetupAbortFlat>> | undefined;
    const second = observer.observeSetupAbortFlat(address).then(value => { proof = value; }).catch(() => {});
    await vi.advanceTimersByTimeAsync(9001);
    expect(native).toHaveBeenCalledTimes(2);
    // Assert before awaiting: Node AbortSignal.timeout uses its own real clock.
    expect(proof).toBeDefined();
    await second;
    expect(proof).toMatchObject({ purpose: 'setup-abort-return', snapshot: { observedAt: started, completedAt: started, withdrawable: '49',
      coverage: { complete: true, earliestProviderTime: started } } });
    expect(first.snapshot.observedAt).toBeLessThan(proof!.snapshot.observedAt);
    expect(proof!.snapshot.observedAt).not.toBe(Date.now()); // Original clock retained.
    expect(budget.introspect()).toMatchObject({ configuredBudgetPerMin: 400, burstCapacity: 800, weightLastMinute: 569 });
  } finally { budget.onModuleDestroy(); }
});

it('abort proofs still refuse an exhausted live bucket before any native read', async () => {
  vi.useFakeTimers();
  const c = testConfig().value, config = new AppConfig({ ...c, hyperliquid: { ...c.hyperliquid, budgetPerMin: 400, burst: 800, startupPaceSeconds: 0 } });
  const budget = new RequestBudgeterService(config), { observer, fetcher, native } = composedObserver(budget, config);
  try {
    const exhausted = budget.acquire(800, 'live');
    await vi.advanceTimersByTimeAsync(0);
    await exhausted;
    await expect(observer.observeSetupAbortFlat(address)).rejects.toMatchObject({
      code: 'live_account_observation_unavailable',
    });
    expect(native).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(budget.introspect()).toMatchObject({ weightLastMinute: 800, configuredBudgetPerMin: 400, burstCapacity: 800 });
  } finally { budget.onModuleDestroy(); }
});
