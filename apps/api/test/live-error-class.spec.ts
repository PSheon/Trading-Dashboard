import { BadGatewayException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { assertSetupTimings, DEFAULT_LIVE_SETUP_TIMINGS, setupStepBudgetMs } from '../src/config/live-timings.js';
import { classify, exhausted, IDENTITY_UNVERIFIED_ISSUE, liveRetryDelayMs, PRIVY_IDENTITY_EVIDENCE_CODES, StepFail, StepWait } from '../src/copy/live/error-class.js';
import { AgentIdentityEvidenceExpired } from '../src/copy/copy-agent.service.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import { HyperliquidBudgetOverCapacity, HyperliquidBudgetWait, SHARED_CAPACITY_RETRY_MS } from '../src/hyperliquid/hyperliquid-budget-wait.js';
/** What the account observer throws when what failed underneath was `cause` (LiveObservationUnavailable). */
const unavailable = (cause: unknown) => Object.assign(new LiveBoundaryError('live_account_observation_unavailable'), { cause });
import { HyperliquidRestCapacityError } from '../src/hyperliquid/hyperliquid-capacity-error.js';

describe('the live error classifier', () => {
  it('a Hyperliquid weight wait is budget at its estimate (at least 1 s): the shared window when the meter said, a local bucket its own', () => {
    expect(classify(new HyperliquidBudgetWait(20_000, 'shared_capacity'))).toEqual({ class: 'budget', code: 'hyperliquid_busy', source: 'budget', retryAfterMs: 20_000 });
    expect(classify(new HyperliquidBudgetWait(70_000, 'shared_capacity')).retryAfterMs).toBe(70_000);
    expect(classify(new HyperliquidBudgetWait(10, 'shared_capacity')).retryAfterMs).toBe(1_000);
    expect(classify(new HyperliquidBudgetWait(22_600, 'local_budget')).retryAfterMs).toBe(22_600);
    expect(classify(new HyperliquidBudgetWait(10, 'local_budget')).retryAfterMs).toBe(1_000);
    // The shared meter's refusals, typed or by code.
    // A refusal that says when is retried then (and a little after); one that can't say, a window later.
    expect(classify(new HyperliquidRestCapacityError(5_000))).toEqual({ class: 'budget', code: 'hyperliquid_quota_exhausted', source: 'boundary', retryAfterMs: 5_250 });
    expect(classify(new LiveBoundaryError('hyperliquid_quota_exhausted'))).toMatchObject({ class: 'budget', retryAfterMs: SHARED_CAPACITY_RETRY_MS });
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
  it("a setup abort's stale or unavailable evidence only waits; a binding that no longer matches, or a refused refund, is permanent", () => {
    for (const code of ['setup_abort_evidence_unavailable', 'setup_abort_proof_stale', 'setup_abort_proof_not_flat', 'setup_abort_lease_changed', 'setup_abort_unavailable'])
      expect(classify(new ConflictException({ statusCode: 409, code, message: 'x' }))).toEqual({ class: 'transient', code, source: 'http', exhausts: true });
    for (const code of ['setup_abort_binding_unknown', 'setup_abort_generation_conflict', 'setup_abort_wallet_conflict', 'setup_abort_refund_not_completed'])
      expect(classify(new ConflictException({ statusCode: 409, code, message: 'x' })).class).toBe('permanent');
    // Not flat waits; past SETUP_ABORT_NOT_FLAT_ESCALATE_MS it is the owner's.
    expect(classify(new ConflictException({ statusCode: 409, code: 'setup_abort_not_flat_persistent', message: 'x' })).class).toBe('needs_owner');
  });
  it('a transient failure is exhausted at the limit; budget, owner and unknown outcomes never are', () => {
    const transient = classify(new Error('privy_unavailable'));
    expect([1, 2, 3, 4].map(attempts => exhausted(transient, attempts, 3))).toEqual([false, false, true, true]);
    expect(exhausted(classify(new HyperliquidBudgetWait(1_000, 'local_budget')), 99, 3)).toBe(false);
    expect(exhausted(classify(new LiveBoundaryError('wallet_authorization_revoked')), 99, 3)).toBe(false);
    expect(exhausted(classify(new LiveBoundaryError('account_action_submission_unknown')), 99, 3)).toBe(false);
  });
});

describe('a Privy identity proof that aged out (gate run 8, 2026-10-13)', () => {
  it('is a transient wait that becomes needs_owner at the attempts limit, never permanent', () => {
    for (const code of PRIVY_IDENTITY_EVIDENCE_CODES) {
      const classified = classify(new ConflictException(code));
      expect(classified).toEqual({ class: 'transient', code, source: 'message', exhausts: true, exhaustedAs: 'needs_owner' });
      expect(exhausted(classified, 8, 8)).toBe(true);
    }
    expect(classify(new AgentIdentityEvidenceExpired())).toMatchObject({ class: 'transient', code: 'agent_identity_evidence_expired', exhaustedAs: 'needs_owner' });
    expect([...PRIVY_IDENTITY_EVIDENCE_CODES].sort((a, b) => a.localeCompare(b))).toEqual(['account_mode_identity_evidence_expired', 'agent_identity_evidence_expired', 'funding_identity_evidence_expired']);
    expect(IDENTITY_UNVERIFIED_ISSUE).toBe('privy_identity_unverified');
    expect(classify(new ConflictException(IDENTITY_UNVERIFIED_ISSUE))).toMatchObject({ class: 'needs_owner' });
    // The exchange's own evidence expiring stays an ordinary transient failure.
    expect(classify(new ConflictException('account_mode_evidence_expired')).exhaustedAs).toBeUndefined();
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

describe('the gate of 2026-10-13 11:15 (7th run): what an order and a stop waited on', () => {
  it('a busy live-risk lock is a wait of a second, never an attempt', () => {
    expect(classify(new LiveBoundaryError('live_risk_busy'))).toEqual({ class: 'budget', code: 'live_risk_busy', source: 'boundary', retryAfterMs: 1_000 });
    expect(exhausted(classify(new LiveBoundaryError('live_risk_busy')), 99, 3)).toBe(false);
  });
  it('an observation the shared meter refused (its socket connect, a read) is a wait for when the meter said; one that failed otherwise is still transient', () => {
    expect(classify(unavailable(new HyperliquidRestCapacityError(4_000)))).toEqual({ class: 'budget', code: 'live_account_observation_unavailable', source: 'boundary', retryAfterMs: 4_250 });
    expect(classify(unavailable(new LiveBoundaryError('hyperliquid_quota_exhausted')))).toMatchObject({ class: 'budget', retryAfterMs: SHARED_CAPACITY_RETRY_MS });
    expect(classify(unavailable(new TypeError('fetch failed')))).toMatchObject({ class: 'transient', code: 'live_account_observation_unavailable', exhausts: true });
    expect(classify(new LiveBoundaryError('live_account_observation_unavailable'))).toMatchObject({ class: 'transient' });
  });
  it('one retry policy for a leg and a stop: a wait when it said (at least 1 s), a failed provider read 10 s, else 3 s', () => {
    expect(liveRetryDelayMs(unavailable(new HyperliquidRestCapacityError(4_000)))).toBe(4_250);
    expect(liveRetryDelayMs(new LiveBoundaryError('live_risk_busy'))).toBe(1_000);
    expect(liveRetryDelayMs(new HyperliquidBudgetWait(20, 'local_budget'))).toBe(1_000);
    expect(liveRetryDelayMs(unavailable(new TypeError('fetch failed')))).toBe(10_000);
    expect(liveRetryDelayMs(new LiveBoundaryError('live_risk_stale'))).toBe(10_000);
    expect(liveRetryDelayMs(new LiveBoundaryError('no_follower_position'))).toBe(3_000);
  });
});
