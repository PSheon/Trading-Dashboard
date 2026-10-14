import 'reflect-metadata';
import { ConflictException, Logger } from '@nestjs/common';
import { afterEach, expect, it, vi } from 'vitest';
import { AppConfig } from '../src/config/app-config.js';
import { CopyLiveSetupAbortService } from '../src/copy/copy-live-setup-abort.service.js';
import { CopyLiveApiSettlementService } from '../src/copy/live-worker/copy-live-api-settlement.service.js';
import { CopyLiveStopper, type StopperDependencies } from '../src/copy/live-worker/copy-live-stopper.js';
import { HyperliquidBudgetWait } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { DEFAULT_LIVE_STOP_TIMINGS } from '../src/config/live-timings.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import { testConfig } from './config-test-utils.js';

// Loops that keep going past a failure say what it was: the code (an
// HttpException's, a boundary code, or `unexpected`), safeErrorText, and a
// Hyperliquid wait's detail. What they store and do next is unchanged.
afterEach(() => { vi.restoreAllMocks(); });
const payload = (line: string) => JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>;
const busy = () => new HyperliquidBudgetWait(12_345, 'local_budget', { weight: 613, lane: 'live', bucket: 'wallet:testnet', tokens: 40, queued: 1 });

it("the stopper logs what a step's failure was, and still stores stop_step_failed and goes on to the next stop", async () => {
  const log = vi.fn<(message: string) => void>(), issue = vi.fn(async () => undefined);
  const repository = { expirePendingRevokes: async () => [], open: async () => [{ id: 's1' }, { id: 's2' }, { id: 's3' }], issue };
  const stopper = new CopyLiveStopper({ repository, closer: {}, canceller: null, swept: async () => false, log } as unknown as StopperDependencies);
  const step = vi.spyOn(stopper, 'step').mockRejectedValueOnce(new TypeError('provider said 0xsecret')).mockRejectedValueOnce(new ConflictException({ code: 'agent_not_active' }))
    .mockRejectedValueOnce(busy());
  await stopper.tick();
  expect(step).toHaveBeenCalledTimes(3);
  expect(issue.mock.calls.map(call => (call as unknown[])[1])).toEqual(['stop_step_failed', 'stop_step_failed', 'stop_step_failed']);
  const [first, second, third] = log.mock.calls.map(([line]) => line);
  expect(first).toMatch(/^stop s1 kept for the next pass: stop_step_failed \{/); expect(first).not.toContain('0xsecret');
  expect(payload(first!)).toMatchObject({ code: 'unexpected', error: expect.stringMatching(/^TypeError/) });
  expect(payload(second!)).toMatchObject({ code: 'agent_not_active' });
  expect(payload(third!)).toEqual({ code: 'hyperliquid_busy', error: '503 live_budget_wait',
    wait: { reason: 'local_budget', retryMs: 12_345, weight: 613, lane: 'live', bucket: 'wallet:testnet', tokens: 40, queued: 1 } });
});

it("the stopper stores a boundary code as it is (and anything else as stop_step_failed), and looks for system stops at its configured interval", async () => {
  const issue = vi.fn(async () => undefined), stopExpiring = vi.fn(async () => ({ stopped: [], refused: [] }));
  let clock = 1_000_000;
  const repository = { expirePendingRevokes: async () => [], open: async () => [{ id: 's1' }, { id: 's2' }], issue };
  const deps = (timings?: StopperDependencies['timings']) => ({ repository, closer: {}, canceller: null, swept: async () => false, ...(timings ? { timings } : {}),
    systemStops: { agentExpiryMarginMs: 1, stopExpiring, resumePendingCloseAll: async () => [] } }) as unknown as StopperDependencies;
  const stopper = new CopyLiveStopper(deps(), () => clock);
  vi.spyOn(stopper, 'step').mockRejectedValueOnce(new LiveBoundaryError('cancel_current_authority_stale')).mockRejectedValueOnce(new LiveBoundaryError('live_budget_over_capacity'));
  await stopper.tick();
  expect(issue.mock.calls.map(call => (call as unknown[])[1])).toEqual(['cancel_current_authority_stale', 'live_budget_over_capacity']);
  // Default: once a minute.
  clock += 59_999; await stopper.tick(); expect(stopExpiring).toHaveBeenCalledTimes(1);
  clock += 1; await stopper.tick(); expect(stopExpiring).toHaveBeenCalledTimes(2);
  // Configured (AppConfig.copy.live.stop.systemCheckMs).
  const fast = new CopyLiveStopper(deps({ ...DEFAULT_LIVE_STOP_TIMINGS, systemCheckMs: 5_000 }), () => clock);
  vi.spyOn(fast, 'step').mockResolvedValue(undefined);
  await fast.tick(); clock += 5_000; await fast.tick();
  expect(stopExpiring).toHaveBeenCalledTimes(4);
});

it('API settlement logs which key failed and why, and still goes on to the next key', async () => {
  const c = testConfig().value;
  const config = new AppConfig({ ...c, app: { ...c.app, nodeEnv: 'development', isWorker: false }, hyperliquid: { ...c.hyperliquid, wallet: { ...c.hyperliquid.wallet, network: 'testnet' } },
    copy: { ...c.copy, live: { network: 'testnet' } } } as never);
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const run = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValueOnce(undefined);
  const api = new CopyLiveApiSettlementService(config, new BackgroundJobs(), { candidates: async () => ['testnet:a:k1', 'testnet:a:k2'] } as never, { run } as never, () => { throw Error('unused'); });
  await api.tick();
  expect(run).toHaveBeenCalledTimes(2);
  const lines = warn.mock.calls.map(([line]) => String(line));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^Terminal settlement testnet:a:k1 pending; durable journal retained \{/);
  expect(payload(lines[0]!)).toMatchObject({ code: 'hyperliquid_busy', wait: { weight: 613, bucket: 'wallet:testnet' } });
  // Admission itself failing says why too.
  const failing = new CopyLiveApiSettlementService(config, new BackgroundJobs(), { candidates: async () => { throw new TypeError('db down'); } } as never, { run } as never, () => { throw Error('unused'); });
  await failing.tick();
  expect(payload(String(warn.mock.calls.at(-1)![0]))).toMatchObject({ code: 'unexpected', error: expect.stringMatching(/^TypeError/) });
  api.onModuleDestroy(); failing.onModuleDestroy();
});

it('the terminal settlement loop logs why an order is still pending, at most once per order per 30 s', async () => {
  const c = testConfig().value;
  const config = new AppConfig({ ...c, hyperliquid: { ...c.hyperliquid, wallet: { ...c.hyperliquid.wallet, network: 'testnet' } },
    copy: { ...c.copy, live: { network: 'testnet' } } } as never);
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  let clock = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const claim = { assertFresh: () => undefined };
  const run = vi.fn(async (_key: string, work: (claim: unknown) => Promise<void>) => { await work(claim); return true; });
  const finish = vi.fn(async () => undefined);
  const work = () => ({ repository: { load: async () => ({ request: {}, row: {} }), finish }, saveSettlement: async () => true,
    settle: async () => ({ kind: 'pending' as const, reason: 'live_settlement_terminal_stale' }) });
  const api = new CopyLiveApiSettlementService(config, new BackgroundJobs(), { candidates: async () => ['testnet:a:k1', 'testnet:a:k2'] } as never, { run } as never, work as never);
  const pending = () => warn.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('settlement '));
  await api.tick(); clock += 3000; await api.tick(); clock += 26_000; await api.tick();
  expect(pending()).toEqual(['settlement testnet:a:k1 pending: live_settlement_terminal_stale', 'settlement testnet:a:k2 pending: live_settlement_terminal_stale']);
  clock += 1000; await api.tick();
  expect(pending()).toHaveLength(4);
  // What the loop stores and does next is unchanged.
  expect(finish).toHaveBeenCalledTimes(8);
  api.onModuleDestroy();
});

it("a setup abort logs a child's reconcile it keeps for the next pass, and finishes the pass as before", async () => {
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const row = { id: 'abort-1', userId: 7, kind: 'edit', stopId: null, network: 'testnet', strategyId: 70 };
  const children = { funding: [], otherFunding: [], modes: [{ id: 'mode-1', submissionState: 'signing' }], agents: [{ id: 'agent-1', state: 'approval_unknown' }], builders: [] };
  const repository = { lease: vi.fn(async () => row), children: vi.fn(async () => children), finishPending: vi.fn(async () => true), transition: vi.fn(), release: vi.fn(async () => undefined) };
  const modes = { reconcile: vi.fn(async () => { throw new ConflictException({ code: 'account_mode_evidence_stale' }); }) };
  const agents = { reconcile: vi.fn(async () => { throw busy(); }) };
  const args = [testConfig(), repository, {}, {}, {}, {}, agents, modes, {}, {}, {}, {}, {}, {}, Date.now] as unknown as ConstructorParameters<typeof CopyLiveSetupAbortService>;
  await new CopyLiveSetupAbortService(...args).process(row.id);
  expect(modes.reconcile).toHaveBeenCalledOnce(); expect(agents.reconcile).toHaveBeenCalledOnce();
  expect(repository.finishPending).toHaveBeenCalledOnce(); expect(repository.transition).not.toHaveBeenCalled(); expect(repository.release).toHaveBeenCalledOnce();
  const lines = warn.mock.calls.map(([line]) => String(line));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^setup abort abort-1 mode mode-1 reconcile kept for the next pass \{/);
  expect(payload(lines[0]!)).toMatchObject({ code: 'account_mode_evidence_stale' });
  expect(lines[1]).toMatch(/^setup abort abort-1 agent agent-1 reconcile kept for the next pass \{/);
  expect(payload(lines[1]!)).toMatchObject({ code: 'hyperliquid_busy', wait: { reason: 'local_budget', weight: 613 } });
});
