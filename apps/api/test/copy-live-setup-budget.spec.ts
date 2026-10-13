import 'reflect-metadata';
import type { FactoryProvider } from '@nestjs/common';
import { afterEach, expect, it, vi } from 'vitest';
import { AppConfig } from '../src/config/app-config.js';
import { CopyModule } from '../src/copy/copy.module.js';
import { ACCOUNT_MODE_ABSENCE_READER, ACCOUNT_MODE_CLIENT, ATTEMPT_WEIGHT } from '../src/copy/copy-account-mode.service.js';
import { ACCOUNT_MODE_ABSENCE_WEIGHT } from '../src/copy/copy-account-mode-evidence.js';
import { AGENT_APPROVAL_CLIENT, AGENT_OBSERVE_WEIGHT } from '../src/copy/copy-agent-exchange.client.js';
import { DEFAULT_LIVE_SETUP_TIMINGS, setupStepBudgetMs } from '../src/config/live-timings.js';
import { HyperliquidBudgetWait, LIVE_RESERVE_WAIT_MS, type LiveBudget } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { RequestBudgeterService } from '../src/hyperliquid/request-budgeter.service.js';
import { LIVE_HEADROOM_SHARE, type WalletNetworkHyperliquid } from '../src/hyperliquid/wallet-network-hyperliquid.js';
import { testConfig } from './config-test-utils.js';
import { offlineGlobalTransport } from './hyperliquid-global-test-utils.js';

// The registered setup clients (CopyModule's factories) on a real bucket
// shaped like mainnet real-money copy's (COPY_LIVE_WEIGHT_PER_MIN 300: burst
// 900, 80 % of it the live reserve). Nothing is read or sent: only weight.
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function wallet() {
  const c = testConfig().value;
  const config = new AppConfig({ ...c, hyperliquid: { ...c.hyperliquid, budgetPerMin: 300, burst: 900, startupPaceSeconds: 0, liveHeadroomShare: LIVE_HEADROOM_SHARE } });
  // `budget`: the setup bucket the setup clients take from; `orders`: the
  // wallet network's order bucket beside it (never theirs).
  const budget = new RequestBudgeterService(config), orders = new RequestBudgeterService(config), { transport } = offlineGlobalTransport(vi.fn<typeof fetch>());
  const factory = (token: symbol) => (Reflect.getMetadata('providers', CopyModule) as FactoryProvider[]).find(provider => provider.provide === token)!.useFactory;
  const hl = { network: 'mainnet', budget: orders, setupBudget: budget, transport, config, dedicated: true } as unknown as WalletNetworkHyperliquid;
  const reserve = {
    mode: (weight: number) => (factory(ACCOUNT_MODE_CLIENT)(config, hl) as { reserve(weight: number): Promise<unknown> }).reserve(weight),
    agent: (weight: number) => (factory(AGENT_APPROVAL_CLIENT)(config, hl) as { reserve(weight: number): Promise<unknown> }).reserve(weight),
    absence: (weight: number) => (factory(ACCOUNT_MODE_ABSENCE_READER)(config, hl) as unknown as { acquire: LiveBudget }).acquire(weight),
  };
  return { budget, orders, reserve };
}

const SETUP_RESERVE_WAIT_MS = DEFAULT_LIVE_SETUP_TIMINGS.stepBudgetMs.reserveWaitMs;
it('a setup step waits in line at most a quarter of its lease', () => {
  expect(SETUP_RESERVE_WAIT_MS).toBe(15_000);
  // The wait, the signature and the POST all fit in one lease.
  expect(setupStepBudgetMs(DEFAULT_LIVE_SETUP_TIMINGS)).toBeLessThan(DEFAULT_LIVE_SETUP_TIMINGS.leaseMs);
});

it("the account-mode attempt (613) queues past 8 s instead of being refused, and background work can't take the refill meanwhile", async () => {
  vi.useFakeTimers();
  const { budget, reserve } = wallet();
  try {
    await budget.acquire(350, 'live'); // 550 left: 613 is 63 short, 12.6 s at 300/min.
    const estimate = budget.liveWaitMs(ATTEMPT_WEIGHT);
    expect(estimate).toBeGreaterThan(LIVE_RESERVE_WAIT_MS); expect(estimate).toBeLessThan(SETUP_RESERVE_WAIT_MS);
    let outcome: unknown;
    void reserve.mode(ATTEMPT_WEIGHT).then(value => { outcome = value ?? 'reserved'; }, (error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(0);
    // Refused at once on 8 s before (then background drained the bucket
    // before the next try, the mainnet loop); now it waits at the head of the line.
    expect(outcome).toBeUndefined(); expect(budget.queued().live).toBe(1);
    // Snapshots, receipts, sweeps: a stream of small background calls.
    let served = 0;
    const competitors = Array.from({ length: 200 }, () => budget.acquire(2, 'background').then(() => { served++; }, () => undefined));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(outcome).toBeUndefined(); expect(served).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toMatchObject({ consume: expect.any(Function), release: expect.any(Function) });
    expect(budget.queued().live).toBe(0);
    expect(budget.introspect().consumers.live).toBe(350 + ATTEMPT_WEIGHT);
    void Promise.all(competitors);
  } finally { budget.onModuleDestroy(); }
});

it.each([['agent', AGENT_OBSERVE_WEIGHT], ['absence', ACCOUNT_MODE_ABSENCE_WEIGHT]] as const)('the %s client queues its %i past 8 s too', async (client, weight) => {
  vi.useFakeTimers();
  const { budget, reserve } = wallet();
  try {
    // About 11 s short at 300/min (5 a second): past the old 8 s, inside 15 s.
    await budget.acquire(900 - (weight - 55), 'live');
    expect(budget.liveWaitMs(weight)).toBeGreaterThan(LIVE_RESERVE_WAIT_MS);
    let outcome: unknown;
    void reserve[client](weight).then(() => { outcome = 'reserved'; }, (error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(LIVE_RESERVE_WAIT_MS + 2_000);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(SETUP_RESERVE_WAIT_MS - LIVE_RESERVE_WAIT_MS);
    expect(outcome).toBe('reserved');
  } finally { budget.onModuleDestroy(); }
});

it('a reservation the bucket cannot give within the setup wait is a wait that says which bucket, weight and backlog, and takes nothing', async () => {
  vi.useFakeTimers();
  // AbortSignal.timeout runs on Node's own clock: on the fake one here.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(new DOMException('timed out', 'TimeoutError')), ms); return c.signal; });
  const { budget, reserve } = wallet();
  try {
    await budget.acquire(900, 'live'); // Empty: 613 needs about 123 s.
    let outcome: unknown;
    void reserve.mode(ATTEMPT_WEIGHT).then(() => { outcome = 'reserved'; }, (error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(SETUP_RESERVE_WAIT_MS + 1_001);
    expect(outcome).toBeInstanceOf(HyperliquidBudgetWait);
    const wait = outcome as HyperliquidBudgetWait;
    expect(wait.reason).toBe('local_budget');
    expect(wait.detail).toMatchObject({ weight: ATTEMPT_WEIGHT, lane: 'live', bucket: 'setup:mainnet', queued: 0 });
    expect(wait.detail.tokens).toBeGreaterThan(50); expect(wait.detail.tokens).toBeLessThan(ATTEMPT_WEIGHT);
    expect(wait.retryMs).toBeGreaterThan(1_000);
    expect(budget.queued()).toEqual({ live: 0, background: 0 });
    // The HTTP answer is unchanged: the detail is for the log and the row only.
    expect(wait.getResponse()).toEqual({ statusCode: 503, code: 'hyperliquid_busy', message: 'Hyperliquid is busy; try again shortly', retryAfterMs: Math.ceil(wait.retryMs) });
  } finally { budget.onModuleDestroy(); }
});

it("the setup clients take their weight from the setup bucket, never the order bucket (gate 2026-10-13 11:13: a setup's 715 + 81 drained the order bucket before its copy's first order)", async () => {
  const { budget, orders, reserve } = wallet();
  try {
    const before = orders.introspect().tokensAvailable;
    await reserve.mode(ATTEMPT_WEIGHT);
    await reserve.agent(AGENT_OBSERVE_WEIGHT);
    await reserve.absence(ACCOUNT_MODE_ABSENCE_WEIGHT);
    expect(orders.introspect().consumers).toEqual({});
    expect(orders.introspect().tokensAvailable).toBeGreaterThanOrEqual(before);
    expect(budget.introspect().consumers.live).toBe(ATTEMPT_WEIGHT + AGENT_OBSERVE_WEIGHT + ACCOUNT_MODE_ABSENCE_WEIGHT);
  } finally { budget.onModuleDestroy(); orders.onModuleDestroy(); }
});
