import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTLEMENT_RETRY_ATTEMPTS, SETTLEMENT_RETRY_MS } from '../src/config/constants/timings.js';
import { CopyLiveEngine, type LiveEngineDependencies } from '../src/copy/live-worker/copy-live-engine.js';
import { SETTLEMENT_NEEDS_OWNER, SettlementRetries } from '../src/copy/live-worker/settlement-retries.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import { HyperliquidRestCapacityError } from '../src/hyperliquid/hyperliquid-capacity-error.js';

/**
 * Gate 11 (2026-10-16): a copy was stopped and its position closed while its
 * first order's settlement was still pending. The settlement could never
 * prove the order again (live_settlement_position_changed, or
 * live_account_observation_unavailable) and the settlement loop retried it every 3 s at
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

  it('the engine spaces its failed passes, and after the cap quarantines it with an ALERT and never settles it again', async () => {
    let clock = 1_000_000;
    const row = { id: 'd', mandateId: 'm', userId: 1, strategyId: 9, accountId: 'a', sourceFillId: 'f', leg: 'open', state: 'submitted', executionKey: KEY, attempts: 1, reason: null } as const;
    const mandate = { mandateId: 'm', userId: 1, strategyId: 9, accountId: 'a', accountAddress: `0x${'11'.repeat(20)}`, sourceNetwork: 'mainnet', leaderAddress: `0x${'22'.repeat(20)}` } as const;
    const passes: number[] = [];
    const settle = vi.fn(async () => { passes.push(clock); throw changed(); }), quarantine = vi.fn(async () => ({ kind: 'quarantine' as const, reason: 'live_settlement_needs_owner', flat }));
    const update = vi.fn(async () => true), alert = vi.fn();
    const deps = { network: 'mainnet', repository: { journalState: async () => 'filled', update }, settler: { settle, quarantine }, alert } as unknown as LiveEngineDependencies;
    const engine = new CopyLiveEngine(deps, { testnetSourceIntervalMs: 60000, sourceLagMs: 1000, passBudgetMs: 20000 }, () => clock);
    let thrown = 0;
    for (let t = 0; t < 60; t++, clock += 3000) {
      if (update.mock.calls.length) break;
      try { await engine.work(row as never, mandate as never, 120000); } catch (error) { expect(error).toBeInstanceOf(LiveBoundaryError); thrown++; }
    }
    expect(settle).toHaveBeenCalledTimes(SETTLEMENT_RETRY_ATTEMPTS); expect(thrown).toBe(SETTLEMENT_RETRY_ATTEMPTS - 1);
    // Every failed pass waited its retry (6 s; a tick is 3 s), and there were exactly the cap's.
    for (let i = 1; i < passes.length; i++) expect(passes[i]! - passes[i - 1]!).toBeGreaterThanOrEqual(SETTLEMENT_RETRY_MS);
    expect(quarantine).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(row, { state: 'refused', reason: SETTLEMENT_NEEDS_OWNER });
    // Once: an ALERT naming the attempts, the last code and the flat stop.
    const lines = alert.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('ALERT settlement_needs_owner'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!.slice(lines[0]!.indexOf('{')))).toMatchObject({ key: KEY, attempts: SETTLEMENT_RETRY_ATTEMPTS, lastCode: 'live_settlement_position_changed', flatStop: { stopId: 'stop-1' } });
  });
});
