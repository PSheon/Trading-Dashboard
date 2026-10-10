import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import type { FactoryProvider } from '@nestjs/common';
import { afterEach, expect, it, vi } from 'vitest';
import { AppConfig } from '../src/config/app-config.js';
import { CopyModule } from '../src/copy/copy.module.js';
import { CopyLiveSetupAbortService, SETUP_ABORT_OBSERVER } from '../src/copy/copy-live-setup-abort.service.js';
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

it('abort proofs still refuse an exhausted live bucket behind prior original work before any native read', async () => {
  vi.useFakeTimers();
  const c = testConfig().value, config = new AppConfig({ ...c, hyperliquid: { ...c.hyperliquid, budgetPerMin: 400, burst: 800, startupPaceSeconds: 0 } });
  const budget = new RequestBudgeterService(config), { observer, fetcher, native } = composedObserver(budget, config);
  try {
    const exhausted = budget.acquire(800, 'live');
    await vi.advanceTimersByTimeAsync(0);
    await exhausted;
    void budget.acquire(800, 'live').catch(() => undefined); // Ahead of this proof; cannot fit its bounded wait.
    await expect(observer.observeSetupAbortFlat(address)).rejects.toMatchObject({
      code: 'live_account_observation_unavailable',
    });
    expect(native).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(budget.introspect()).toMatchObject({ weightLastMinute: 800, configuredBudgetPerMin: 400, burstCapacity: 800 });
  } finally { budget.onModuleDestroy(); }
});

function recoveryPass(config: AppConfig, budget: RequestBudgeterService, observer: HyperliquidLiveAccountObserver,
  options: { prepared?: boolean; attempted?: boolean; rejection?: string; delayMs?: number } = {}) {
  const row = { id: 'original-abort', userId: 14, kind: 'start', network: 'testnet', accountId: 'account', accountAddress: address,
    fundingOperationId: 'original-deposit', returnOperationId: options.prepared === false ? null : 'original-refund', stopId: null };
  const refund = { id: 'original-refund', setupAbortId: row.id, userId: 14, network: 'testnet', accountId: 'account', address,
    destination: `0x${'33'.repeat(20)}`, strategyId: 70, direction: 'to_main', status: 'prepared', amount: '49', nonce: 123,
    attemptedAt: options.attempted ? new Date() : null };
  const children = { funding: [{ id: 'original-deposit', direction: 'to_account', network: 'testnet', strategyId: 70, status: 'credited' },
    ...(options.prepared === false ? [] : [refund])], otherFunding: [], modes: [], agents: [], builders: [] };
  Object.assign(row, { strategyId: 70 });
  const repository = { lease: vi.fn(async () => row), children: vi.fn(async () => children), find: vi.fn(async () => row),
    transition: vi.fn(async (_row: unknown, patch: Record<string, unknown>) => ({ ...row, ...patch })), release: vi.fn(async () => {}) };
  const refunds = { complete: vi.fn(async (_row: unknown, _proof: unknown, _now: unknown) => false), reserve: vi.fn(async () => { row.returnOperationId = refund.id; return refund; }),
    begin: vi.fn(async (_row: unknown, id: string, proof: { snapshot: { observedAt: number } }) => {
      if (options.delayMs) await vi.advanceTimersByTimeAsync(options.delayMs);
      if (options.rejection) throw new ConflictException({ code: options.rejection });
      if (Date.now() - proof.snapshot.observedAt > 5000) throw new ConflictException({ code: 'setup_abort_proof_stale' });
      if (refund.attemptedAt) return null;
      expect(id).toBe(refund.id); return { ...refund, status: 'unknown', attemptedAt: new Date() };
    }) };
  const returns = { contextRead: vi.fn(async () => ({ account: { privyWalletId: 'wallet', masterSignerQuorumId: 'quorum', masterPolicyId: 'policy' } })),
    finish: vi.fn(async () => {}) };
  const signer = { available: true, sign: vi.fn(async () => ({ r: '0x01', s: '0x02', v: 27 })) };
  const nativeExchange = new CopyFundingExchangeClient(budget);
  const exchange = { acquire: () => nativeExchange.acquire(), send: vi.fn(async (_attempt: unknown, _signature: unknown, fresh: () => void, dispatched: () => void) => {
    fresh(); dispatched(); return { status: 'ok', response: { type: 'default' } };
  }) };
  const serviceConfig = new AppConfig({ ...config.value, copy: { ...config.value.copy, live: { network: config.value.hyperliquid.wallet.network } } } as never);
  const args = [serviceConfig, repository, refunds, {}, {}, {}, {}, {}, {}, returns, exchange, signer, observer, {}, Date.now] as unknown as ConstructorParameters<typeof CopyLiveSetupAbortService>;
  return { service: new CopyLiveSetupAbortService(...args), repository, refunds, exchange, signer, refund };
}

it.each(['accepted', 'credited', 'rejected'] as const)('a delegated stopped generation retains its original %s refund outcome', async status => {
  const config = testConfig(), budget = new RequestBudgeterService(config);
  const observer = { observeSetupAbortFlat: vi.fn() };
  try {
    const pass = recoveryPass(config, budget, observer as unknown as HyperliquidLiveAccountObserver);
    const row = await pass.repository.lease();
    Object.assign(row, { stopId: 'original-stop', mandateId: 'original-mandate' });
    const children = await pass.repository.children();
    Object.assign(children, { stop: { id: 'original-stop', mandateId: 'original-mandate', accountId: 'account', network: 'testnet', state: 'stopped', issue: null } });
    children.funding.splice(1, 1, { ...pass.refund, setupAbortId: null, stopId: 'original-stop', status } as unknown as typeof children.funding[number]);
    await pass.service.process(row.id);
    expect(pass.repository.transition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(
      status === 'credited' ? { state: 'done', issue: null } : status === 'accepted'
        ? { state: 'delegated', issue: 'setup_abort_refund_pending' }
        : { state: 'blocked', issue: 'setup_abort_refund_not_completed' }));
    expect(pass.exchange.send).not.toHaveBeenCalled();
    expect(pass.signer.sign).not.toHaveBeenCalled();
    expect(observer.observeSetupAbortFlat).not.toHaveBeenCalled();
  } finally { budget.onModuleDestroy(); }
});

it('a warmed 400/min bucket submits its original prepared refund with one fresh proof and the same nonce', async () => {
  vi.useFakeTimers();
  const c = testConfig().value, config = new AppConfig({ ...c, hyperliquid: { ...c.hyperliquid, budgetPerMin: 400, burst: 800, startupPaceSeconds: 0 } });
  const budget = new RequestBudgeterService(config), { observer, native } = composedObserver(budget, config);
  try {
    await budget.acquire(515, 'live'); // 285 remain: one proof284 + existing exchange1.
    const pass = recoveryPass(config, budget, observer);
    await pass.service.process('original-abort');
    expect(pass.exchange.send).toHaveBeenCalledTimes(1);
    expect(pass.exchange.send.mock.calls[0]![0]).toMatchObject({ id: 'original-refund', nonce: 123, amount: '49' });
    expect(native).toHaveBeenCalledTimes(1);
    expect(pass.refunds.reserve).not.toHaveBeenCalled();
    expect(pass.refunds.complete).not.toHaveBeenCalled();
    expect(pass.repository.release).toHaveBeenCalledTimes(1);
    expect(budget.introspect()).toMatchObject({ configuredBudgetPerMin: 400, burstCapacity: 800, weightLastMinute: 800 });
  } finally { budget.onModuleDestroy(); }
});

it('new refund reservation retains two independently timed real proofs and original begin', async () => {
  vi.useFakeTimers();
  const c = testConfig().value, config = new AppConfig({ ...c, hyperliquid: { ...c.hyperliquid, budgetPerMin: 400, burst: 800, startupPaceSeconds: 0 } });
  const budget = new RequestBudgeterService(config), { observer, native } = composedObserver(budget, config);
  try {
    const pass = recoveryPass(config, budget, observer, { prepared: false });
    pass.refunds.reserve.mockImplementationOnce(async () => { await vi.advanceTimersByTimeAsync(1); return pass.refund; });
    await pass.service.process('original-abort');
    expect(pass.exchange.send).toHaveBeenCalledTimes(1);expect(native).toHaveBeenCalledTimes(2);
    const first = pass.refunds.complete.mock.calls[0]!, last = pass.refunds.begin.mock.calls[0]!;
    expect((last[2] as {snapshot:{observedAt:number}}).snapshot.observedAt).toBeGreaterThan((first[1] as {snapshot:{observedAt:number}}).snapshot.observedAt);
    expect(pass.refunds.reserve).toHaveBeenCalledTimes(1);
  } finally { budget.onModuleDestroy(); }
});

it.each(['setup_abort_binding_unknown', 'setup_abort_lease_changed'])('prepared recovery preserves locked begin refusal %s before signing', async rejection => {
  vi.useFakeTimers();const c = testConfig().value, config = new AppConfig({ ...c, hyperliquid: { ...c.hyperliquid, budgetPerMin: 400, burst: 800, startupPaceSeconds: 0 } });
  const budget = new RequestBudgeterService(config), { observer } = composedObserver(budget, config);
  try { const pass = recoveryPass(config, budget, observer, { rejection });await pass.service.process('original-abort');
    expect(pass.refunds.begin).toHaveBeenCalledTimes(1);expect(pass.signer.sign).not.toHaveBeenCalled();expect(pass.exchange.send).not.toHaveBeenCalled();
    expect(pass.repository.transition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: 'blocked', issue: rejection }));
  } finally { budget.onModuleDestroy(); }
});

it.each([{ attempted: true }, { delayMs: 5001 }])('prepared recovery cannot sign a prior attempted child or expired purpose proof %j', async options => {
  vi.useFakeTimers();const c = testConfig().value, config = new AppConfig({ ...c, hyperliquid: { ...c.hyperliquid, budgetPerMin: 400, burst: 800, startupPaceSeconds: 0 } });
  const budget = new RequestBudgeterService(config), { observer } = composedObserver(budget, config);
  try { const pass = recoveryPass(config, budget, observer, options);await pass.service.process('original-abort');
    expect(pass.signer.sign).not.toHaveBeenCalled();expect(pass.exchange.send).not.toHaveBeenCalled();
  } finally { budget.onModuleDestroy(); }
});

it('failed prepared recovery retries let the real bucket refill without paying a redundant proof or changing the original nonce', async () => {
  vi.useFakeTimers();const c = testConfig().value, config = new AppConfig({ ...c, hyperliquid: { ...c.hyperliquid, budgetPerMin: 400, burst: 800, startupPaceSeconds: 0 } });
  const budget = new RequestBudgeterService(config), { observer, native } = composedObserver(budget, config);
  try {
    await budget.acquire(799, 'live');const prior = new AbortController();
    void budget.acquire(800, 'live', 0, { signal: prior.signal }).catch(() => undefined);
    const pass = recoveryPass(config, budget, observer);
    await pass.service.process('original-abort');expect(native).not.toHaveBeenCalled();expect(pass.exchange.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);await pass.service.process('original-abort');
    expect(native).not.toHaveBeenCalled();expect(pass.exchange.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);prior.abort();await pass.service.process('original-abort');
    expect(native).toHaveBeenCalledTimes(1);expect(pass.exchange.send).toHaveBeenCalledTimes(1);
    expect(pass.exchange.send.mock.calls[0]![0]).toMatchObject({ id: 'original-refund', nonce: 123 });
    expect(pass.refunds.reserve).not.toHaveBeenCalled();expect(pass.repository.release).toHaveBeenCalledTimes(3);
  } finally { budget.onModuleDestroy(); }
});

it('the registered abort observer queues its full original proof before its evidence clock while ordinary background calls compete', async () => {
  vi.useFakeTimers();const c = testConfig().value, config = new AppConfig({ ...c, hyperliquid: { ...c.hyperliquid, budgetPerMin: 400, burst: 800, startupPaceSeconds: 0 } });
  const budget = new RequestBudgeterService(config), { observer, native } = composedObserver(budget, config);
  try {
    await budget.acquire(700, 'live');
    // Small real background waiters consume their permitted main share; their
    // fairness turn remains enabled while the large original live proof waits.
    const competitors = Array.from({ length: 500 }, () => budget.acquire(2, 'background').catch(() => undefined));
    const requestedAt = Date.now();let proof: Awaited<ReturnType<typeof observer.observeSetupAbortFlat>> | undefined;
    const work = observer.observeSetupAbortFlat(address).then(p => { proof = p; }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(native).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(49_000);
    expect(native).toHaveBeenCalledTimes(1);
    expect(proof).toBeDefined();await work;
    expect(proof!.snapshot.observedAt).toBeGreaterThan(requestedAt + 8000);
    expect(proof!.snapshot.completedAt - proof!.snapshot.observedAt).toBeLessThanOrEqual(5000);
    expect(proof!.snapshot.coverage.earliestProviderTime).toBe(proof!.snapshot.observedAt);
    expect(budget.introspect()).toMatchObject({ configuredBudgetPerMin: 400, effectiveBudgetPerMin: 400, burstCapacity: 800 });
    expect(budget.introspect().consumers.other).toBeGreaterThan(68); // Ordinary fairness was not suspended.
    void Promise.all(competitors);
  } finally { budget.onModuleDestroy(); }
});
