import { BadGatewayException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { assertSetupTimings, DEFAULT_LIVE_SETUP_TIMINGS, setupStepBudgetMs } from '../src/config/live-timings.js';
import { classify, exhausted, StepFail, StepWait } from '../src/copy/live/error-class.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import { HyperliquidBudgetOverCapacity, HyperliquidBudgetWait, SHARED_CAPACITY_RETRY_MS } from '../src/hyperliquid/hyperliquid-budget-wait.js';
import { HyperliquidRestCapacityError } from '../src/hyperliquid/hyperliquid-capacity-error.js';

describe('the live error classifier', () => {
  it('a Hyperliquid weight wait is budget: the shared window no sooner than 65 s, a local bucket its estimate (at least 1 s)', () => {
    expect(classify(new HyperliquidBudgetWait(20_000, 'shared_capacity'))).toEqual({ class: 'budget', code: 'hyperliquid_busy', source: 'budget', retryAfterMs: SHARED_CAPACITY_RETRY_MS });
    expect(classify(new HyperliquidBudgetWait(70_000, 'shared_capacity')).retryAfterMs).toBe(70_000);
    expect(classify(new HyperliquidBudgetWait(22_600, 'local_budget')).retryAfterMs).toBe(22_600);
    expect(classify(new HyperliquidBudgetWait(10, 'local_budget')).retryAfterMs).toBe(1_000);
    // The shared meter's refusals, typed or by code.
    expect(classify(new HyperliquidRestCapacityError(5_000))).toEqual({ class: 'budget', code: 'hyperliquid_quota_exhausted', source: 'boundary', retryAfterMs: SHARED_CAPACITY_RETRY_MS });
    expect(classify(new LiveBoundaryError('hyperliquid_quota_exhausted')).class).toBe('budget');
    expect(classify(new LiveBoundaryError('hyperliquid_quota_queue_full'))).toEqual({ class: 'budget', code: 'hyperliquid_quota_queue_full', source: 'boundary' });
  });
  it("a step's own wait is budget at its time; its own failure is permanent", () => {
    expect(classify(new StepWait('awaiting_credit', 3_000))).toEqual({ class: 'budget', code: 'awaiting_credit', source: 'step', retryAfterMs: 3_000 });
    expect(classify(new StepFail('setup_account_mode_failed'))).toEqual({ class: 'permanent', code: 'setup_account_mode_failed', source: 'step' });
  });
  it('a weight the bucket can never hold is permanent', () => {
    expect(classify(new HyperliquidBudgetOverCapacity(1_000, 720))).toEqual({ class: 'permanent', code: 'live_budget_over_capacity', source: 'boundary' });
  });
  it.each(['consent_expired', 'agent_consent_expired', 'worker_signer_missing', 'wallet_authorization_revoked', 'wallet_authorization_expired', 'exchange_agent_expired'])('%s needs its owner', code => {
    expect(classify(new LiveBoundaryError(code)).class).toBe('needs_owner');
  });
  it('an HttpException is keyed by its response code, else by a message that is a code', () => {
    expect(classify(new ConflictException({ statusCode: 409, code: 'worker_signer_missing', message: 'x' }))).toEqual({ class: 'needs_owner', code: 'worker_signer_missing', source: 'http' });
    expect(classify(new BadGatewayException({ statusCode: 502, code: 'funding_proof_unavailable', message: 'x' }))).toEqual({ class: 'transient', code: 'funding_proof_unavailable', source: 'http', exhausts: true });
    expect(classify(new ConflictException('account_mode_evidence_expired'))).toEqual({ class: 'transient', code: 'account_mode_evidence_expired', source: 'message', exhausts: true });
  });
  it('anything else is transient; an outcome still unknown is never exhausted', () => {
    expect(classify(new TypeError('Cannot read properties of undefined'))).toEqual({ class: 'transient', code: null, source: 'unknown', exhausts: true });
    expect(classify('boom')).toEqual({ class: 'transient', code: null, source: 'unknown', exhausts: true });
    expect(classify(new LiveBoundaryError('live_read_deadline_exceeded'))).toEqual({ class: 'transient', code: 'live_read_deadline_exceeded', source: 'boundary', exhausts: true });
    for (const code of ['account_action_submission_unknown', 'exchange_submission_ambiguous', 'funding_submission_unknown', 'withdrawal_submission_unknown'])
      expect(classify(new LiveBoundaryError(code))).toMatchObject({ class: 'transient', exhausts: false });
  });
  it('a transient failure is exhausted at the limit; budget, owner and unknown outcomes never are', () => {
    const transient = classify(new Error('privy_unavailable'));
    expect([1, 2, 3, 4].map(attempts => exhausted(transient, attempts, 3))).toEqual([false, false, true, true]);
    expect(exhausted(classify(new HyperliquidBudgetWait(1_000, 'local_budget')), 99, 3)).toBe(false);
    expect(exhausted(classify(new LiveBoundaryError('wallet_authorization_revoked')), 99, 3)).toBe(false);
    expect(exhausted(classify(new LiveBoundaryError('account_action_submission_unknown')), 99, 3)).toBe(false);
  });
});

describe('the live setup timings', () => {
  it("today's step (reserve wait, signature, POST) fits inside today's lease", () => {
    expect(setupStepBudgetMs(DEFAULT_LIVE_SETUP_TIMINGS)).toBe(55_000);
    expect(setupStepBudgetMs(DEFAULT_LIVE_SETUP_TIMINGS)).toBeLessThan(DEFAULT_LIVE_SETUP_TIMINGS.leaseMs);
    expect(assertSetupTimings(DEFAULT_LIVE_SETUP_TIMINGS)).toBe(DEFAULT_LIVE_SETUP_TIMINGS);
  });
  it('a step budget equal to or past the lease is refused', () => {
    const at = (leaseMs: number) => () => assertSetupTimings({ ...DEFAULT_LIVE_SETUP_TIMINGS, leaseMs });
    expect(at(55_000)).toThrow('must be below its lease');
    expect(at(55_001)).not.toThrow();
  });
});
