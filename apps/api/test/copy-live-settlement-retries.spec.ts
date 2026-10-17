import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../src/config/app-config.js';
import { SETTLEMENT_RETRY_ATTEMPTS, SETTLEMENT_RETRY_MS } from '../src/config/constants/timings.js';
import { CopyLiveApiSettlementService } from '../src/copy/live-worker/copy-live-api-settlement.service.js';
import { CopyLiveEngine, type LiveEngineDependencies } from '../src/copy/live-worker/copy-live-engine.js';
import { SETTLEMENT_NEEDS_OWNER, SettlementRetries } from '../src/copy/live-worker/settlement-retries.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import { HyperliquidRestCapacityError } from '../src/hyperliquid/hyperliquid-capacity-error.js';
import { BackgroundJobs } from '../src/runtime/background-jobs.service.js';
import { testConfig } from './config-test-utils.js';

/**
 * Gate 11 (2026-10-16): a copy was stopped and its position closed while its
 * first order's settlement was still pending. The settlement could never
 * prove the order again (live_settlement_position_changed, or
 * live_account_observation_unavailable) and the api retried it every 3 s at
 * live priority for 50+ minutes, starving the next copy's orders on the
 * shared IP. Now its failed passes are spaced (SETTLEMENT_RETRY_MS) and
 * counted, and at SETTLEMENT_RETRY_ATTEMPTS its order goes to its owner:
 * quarantined, an ALERT, its dispatch refused, nothing retried after.
 */
afterEach(() => { vi.restoreAllMocks(); });
const KEY = 'testnet:0x00000000000000000000000000000000000000a1:0x11111111111111111111111111111111';
const changed = () => new LiveBoundaryError('live_settlement_position_changed');
const flat = { stopId: 'stop-1', flatDigest: 'f'.repeat(64), flatVerifiedAt: 1_000_000 };

describe('a settlement that can never prove its order', () => {
  it('the api loop spaces its failed passes, and after the cap quarantines it with an ALERT and never settles or claims for it again', async () => {
    const c = testConfig().value;
    const config = new AppConfig({ ...c, hyperliquid: { ...c.hyperliquid, wallet: { ...c.hyperliquid.wallet, network: 'testnet' } }, copy: { ...c.copy, live: { network: 'testnet' } } } as never);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const alert = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let clock = 1_000_000;
    const candidates = new Set([KEY]), passes: number[] = [];
    const settle = vi.fn(async () => { passes.push(clock); throw changed(); });
    const quarantine = vi.fn(async () => ({ kind: 'quarantine' as const, reason: 'live_settlement_needs_owner', flat }));
    const finish = vi.fn(async (_row: unknown, outcome: { kind: string; reason?: string }) => { if (outcome.kind === 'quarantine') candidates.delete(KEY); });
    const run = vi.fn(async (_key: string, work: (claim: unknown) => Promise<void>) => { await work({ assertFresh: () => undefined }); return true; });
    const work = () => ({ repository: { load: async () => ({ request: { key: KEY, accountId: 'a' }, row: {} }), finish }, saveSettlement: async () => true, settle, quarantine });
    const api = new CopyLiveApiSettlementService(config, new BackgroundJobs(), { candidates: async () => [...candidates] } as never, { run } as never, work as never, () => clock);
    // The loop's 3 s ticks for 3 minutes.
    for (let t = 0; t < 60; t++, clock += 3000) await api.tick();
    // Every failed pass waited its retry (6 s; a tick is 3 s), and there were exactly the cap's.
    expect(settle).toHaveBeenCalledTimes(SETTLEMENT_RETRY_ATTEMPTS);
    for (let i = 1; i < passes.length; i++) expect(passes[i]! - passes[i - 1]!).toBeGreaterThanOrEqual(SETTLEMENT_RETRY_MS);
    // Then its owner: quarantined once, its dispatch refused (finish), an ALERT naming the flat stop.
    expect(quarantine).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenLastCalledWith(expect.anything(), { kind: 'quarantine', reason: SETTLEMENT_NEEDS_OWNER });
    const lines = alert.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('ALERT settlement_needs_owner'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!.slice(lines[0]!.indexOf('{')))).toMatchObject({ key: KEY, attempts: SETTLEMENT_RETRY_ATTEMPTS, lastCode: 'live_settlement_position_changed', flatStop: { stopId: 'stop-1' } });
    // Nothing runs for it afterwards (no pass, so no live claim).
    expect(run.mock.calls.length).toBe(SETTLEMENT_RETRY_ATTEMPTS);
    api.onModuleDestroy();
  });

  it('a meter wait is not a failed pass: its next pass is the next tick (renewing its keyed claim, not waiting out the quote), and it is never quarantined for waiting', () => {
    let clock = 0;const retries = new SettlementRetries(() => clock);
    for (let i = 0; i < 3 * SETTLEMENT_RETRY_ATTEMPTS; i++) {
      const verdict = retries.failed(KEY, new HyperliquidRestCapacityError(55_000));
      expect(verdict).toEqual({ kind: 'retry', delayMs: 0, attempts: 0 });
      expect(retries.due(KEY)).toBe(true); clock += 3_000;
    }
    // A bounded wait (the never-placed grace) is not counted either; a settled pass forgets it.
    expect(retries.outcome(KEY, { kind: 'pending', reason: 'live_settlement_never_placed_grace' })).toBeNull();
    for (let i = 1; i < SETTLEMENT_RETRY_ATTEMPTS; i++) expect(retries.outcome(KEY, { kind: 'pending', reason: 'live_settlement_terminal_stale' })).toMatchObject({ kind: 'retry', attempts: i });
    expect(retries.outcome(KEY, { kind: 'released' })).toBeNull();
    expect(retries.due(KEY)).toBe(true); expect(retries.owed(KEY)).toBe(false);
  });

  it('the worker\'s settlement (mainnet) is capped the same way', async () => {
    let clock = 1_000_000;
    const row = { id: 'd', mandateId: 'm', userId: 1, strategyId: 9, accountId: 'a', sourceFillId: 'f', leg: 'open', state: 'submitted', executionKey: KEY, attempts: 1, reason: null } as const;
    const mandate = { mandateId: 'm', userId: 1, strategyId: 9, accountId: 'a', accountAddress: `0x${'11'.repeat(20)}`, sourceNetwork: 'mainnet', leaderAddress: `0x${'22'.repeat(20)}` } as const;
    const settle = vi.fn(async () => { throw changed(); }), quarantine = vi.fn(async () => ({ kind: 'quarantine' as const, reason: 'live_settlement_needs_owner', flat: null }));
    const update = vi.fn(async () => true), alert = vi.fn();
    const deps = { network: 'mainnet', repository: { journalState: async () => 'filled', update }, settler: { settle, quarantine }, alert } as unknown as LiveEngineDependencies;
    const engine = new CopyLiveEngine(deps, { testnetSourceIntervalMs: 60000, sourceLagMs: 1000, passBudgetMs: 20000 }, () => clock);
    let thrown = 0;
    for (let t = 0; t < 60; t++, clock += 3000) {
      if (update.mock.calls.length) break;
      try { await engine.work(row as never, mandate as never, 120000); } catch (error) { expect(error).toBeInstanceOf(LiveBoundaryError); thrown++; }
    }
    expect(settle).toHaveBeenCalledTimes(SETTLEMENT_RETRY_ATTEMPTS); expect(thrown).toBe(SETTLEMENT_RETRY_ATTEMPTS - 1);
    expect(quarantine).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(row, { state: 'refused', reason: SETTLEMENT_NEEDS_OWNER });
    expect(alert).toHaveBeenCalledWith(expect.stringMatching(/^ALERT settlement_needs_owner /));
  });
});
