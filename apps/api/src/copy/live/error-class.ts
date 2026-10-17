import { HttpException } from '@nestjs/common';
import { HyperliquidBudgetWait, sharedCapacityWait } from '../../hyperliquid/hyperliquid-budget-wait.js';
import { sharedRestRetryAfterMs } from '../../hyperliquid/hyperliquid-capacity-error.js';
import { LiveBoundaryError } from './wallet-authorization.js';
import { SHARED_CAPACITY_RETRY_MS } from '../../config/constants/hyperliquid.js';
import { LIVE_LEG_RETRY_BASE_MS, LIVE_RISK_BUSY_RETRY_MS, PROVIDER_READ_RETRY_MS, SETTLEMENT_RETRY_ATTEMPTS, SETTLEMENT_RETRY_MS, SETUP_RETRY_BACKOFF_BASE_MS, SETUP_RETRY_BACKOFF_MAX_MS, SETUP_RETRY_NEEDS_OWNER_MS, SETUP_RETRY_PENDING_MS, WAIT_FLOOR_MS } from '../../config/constants/timings.js';

/**
 * THE classification of a live step's failure (architecture review
 * 2026-10-12 §6.3), keyed by the error's code:
 *
 * - `budget`: not a failure. The step waits for something with a known time:
 *   Hyperliquid weight (a local bucket or the shared per-IP meter), or an
 *   outcome it already started (a lookup, a credit, an approval). Never
 *   counted as an attempt, never exhausted.
 * - `transient`: a failure that may pass. Counted; at the caller's limit of
 *   attempts it is permanent (`exhausted`), except an outcome still unknown
 *   (a submission that may have landed), which is reconciled, never given up.
 * - `permanent`: no retry helps; the operation ends with the code.
 * - `needs_owner`: only the owner can move it on (a signature, a renewed
 *   authorization). Shown to the owner, never exhausted by attempts.
 */
type ErrorClass = 'budget' | 'transient' | 'permanent' | 'needs_owner';

export interface ErrorClassification {
  readonly class: ErrorClass;
  /** The error's own code: a step's issue, a LiveBoundaryError's code, an
   * HttpException's response code, or a message that is a code; null for
   * anything else (a TypeError, a timeout). */
  readonly code: string | null;
  /** Where `code` came from (a stored reason may accept only some sources). */
  readonly source: 'step' | 'budget' | 'boundary' | 'http' | 'message' | 'unknown';
  /** When to look again, when the error says. */
  readonly retryAfterMs?: number;
  /** `transient` only: false for an outcome still unknown (never exhausted). */
  readonly exhausts?: boolean;
  /** `transient` only: what it becomes at the caller's limit of attempts
   * instead of permanent (PRIVY_IDENTITY_EVIDENCE_CODES: its owner is told). */
  readonly exhaustedAs?: 'needs_owner';
}

/** A step can't go on yet (a lookup is pending, or a signature is due): `budget`. */
export class StepWait extends Error {
  constructor(readonly issue: string, readonly retryMs: number) { super(issue); this.name = 'StepWait'; }
}
/** The step cannot finish; its owner sees the code: `permanent`. */
export class StepFail extends Error {
  constructor(readonly issue: string) { super(issue); this.name = 'StepFail'; }
}

/** Codes whose weight is not available yet: nothing was read or sent. */
const BUDGET_CODES: ReadonlyMap<string, number | undefined> = new Map([
  // The shared per-IP meter refused the charge: its window and send window.
  ['hyperliquid_quota_exhausted', SHARED_CAPACITY_RETRY_MS],
  // 64 waiters already queue on the shared meter.
  ['hyperliquid_quota_queue_full', undefined],
  // The explorer (txDetails) could not be reached: DNS, connect or timeout
  // (networkUnreachable). Nothing was learned and nothing is wrong with the
  // operation: it waits, backed off per row, and never counts as an attempt.
  ['funding_explorer_unreachable', undefined],
  // The live-risk scope's advisory try-lock was busy: nothing was read,
  // reserved or sent, so it is not an attempt (gate 2026-10-13 11:15).
  ['live_risk_busy', LIVE_RISK_BUSY_RETRY_MS],
]);
/** Codes that wrap what failed underneath (`cause`): a wait underneath (the
 * shared meter refused a socket connect or a read) makes them a wait too
 * (gate 2026-10-13 11:15). */
const WRAPPING_CODES: ReadonlySet<string> = new Set(['live_account_observation_unavailable']);
/** A failed provider read (it opened a socket or spent weight): its retry is
 * spaced (liveRetryDelayMs), so a burst of them can't use up the 30 new
 * WebSocket connections a minute and the 10 at once. */
export const PROVIDER_READ_FAILURES: ReadonlySet<string> = new Set(['live_account_observation_unavailable', 'live_account_observation_changed', 'live_read_deadline_exceeded',
  'live_risk_stale', 'live_risk_provider_unavailable', 'live_risk_busy']);
/** No retry helps until the configuration changes. */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  // Heavier than the bucket can ever hold (hyperliquid-budget-wait.ts).
  'live_budget_over_capacity',
  // A setup abort whose original setup, generation or wallet no longer
  // matches what it was admitted on, or whose refund the exchange refused:
  // no retry makes it match (copy-live-setup-abort.service.ts).
  'setup_abort_binding_unknown', 'setup_abort_generation_conflict', 'setup_abort_wallet_conflict', 'setup_abort_refund_not_completed',
]);
/** Only the owner can move these on. */
const NEEDS_OWNER_CODES: ReadonlySet<string> = new Set([
  'consent_expired', 'agent_consent_expired', 'worker_signer_missing', 'exchange_agent_expired',
  'wallet_authorization_missing', 'wallet_authorization_expired', 'wallet_authorization_revoked',
  // Money kept landing in a cancelled setup's copy account after its refund
  // and every follow-up (SETUP_ABORT_RESIDUAL_RETURNS) left.
  'setup_abort_residual_balance',
  // A cancelled setup's copy account still not flat (a position, an order,
  // margin) past SETUP_ABORT_NOT_FLAT_ESCALATE_MS: setup_abort_proof_not_flat
  // waits until then (copy-live-setup-abort.service.ts).
  'setup_abort_not_flat_persistent',
  // A Privy identity proof that kept expiring (PRIVY_IDENTITY_EVIDENCE_CODES).
  'privy_identity_unverified',
]);
/** Waits, not failures: a read that was stale or could not be had, or the
 * worker's signer not up yet. Unlisted codes are `transient` already; these
 * are named so no one moves them to a blocking class by accident (a setup
 * abort shows them as waiting, never as needing action). */
const TRANSIENT_WAIT_CODES: ReadonlySet<string> = new Set([
  'setup_abort_evidence_unavailable', 'setup_abort_proof_stale', 'setup_abort_proof_not_flat', 'setup_abort_lease_changed', 'setup_abort_unavailable',
]);
/** A Privy identity proof that aged past PRIVY_IDENTITY_MAX_AGE_MS (a slow
 * link to Privy): nothing was signed or sent. Transient and counted; at the
 * caller's limit it becomes `needs_owner` (IDENTITY_UNVERIFIED_ISSUE) since the
 * link, not the setup, is what's wrong (gate run 8, 2026-10-13). */
export const PRIVY_IDENTITY_EVIDENCE_CODES: ReadonlySet<string> = new Set([
  'agent_identity_evidence_expired', 'account_mode_identity_evidence_expired', 'funding_identity_evidence_expired',
]);
/** What an identity proof that kept expiring leaves on its operation. */
export const IDENTITY_UNVERIFIED_ISSUE = 'privy_identity_unverified';
/** An outcome still unknown: reconciled until known, never given up by count
 * (giving up would abandon a submission that may have landed). */
const UNKNOWN_OUTCOME_CODES: ReadonlySet<string> = new Set([
  'account_action_submission_unknown', 'exchange_submission_ambiguous', 'funding_submission_unknown', 'withdrawal_submission_unknown',
  'cancel_signing_ambiguous', 'non_ioc_partial_fill_requires_reconciliation',
]);
const CODE = /^[a-z][a-z0-9_]{2,79}$/;
/** Network codes that mean the host was never reached or never answered
 * (Node's resolver and sockets, undici's connect and header timeouts). */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
]);

/**
 * Whether a fetch failed because the host could not be reached: a DNS
 * failure, a refused or reset connection, or a timeout (the request's
 * AbortSignal.timeout or undici's own). Looks through `cause` (fetch wraps
 * the socket error in `TypeError: fetch failed`) and an AggregateError's
 * errors (every address refused). An HTTP answer of any status, a refused
 * budget or a bad body is not unreachability.
 */
export function networkUnreachable(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 4) return false;
  const { name, code, cause } = error as { name?: unknown; code?: unknown; cause?: unknown };
  if (name === 'TimeoutError') return true;
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return true;
  if (error instanceof AggregateError && error.errors.some(inner => networkUnreachable(inner, depth + 1))) return true;
  return networkUnreachable(cause, depth + 1);
}

/** The error's own code and where it came from (see ErrorClassification.code). */
function own(error: unknown): Pick<ErrorClassification, 'code' | 'source'> {
  if (error instanceof StepWait || error instanceof StepFail) return { code: error.issue, source: 'step' };
  if (error instanceof HyperliquidBudgetWait) return { code: 'hyperliquid_busy', source: 'budget' };
  if (error instanceof HttpException) {
    const response = error.getResponse(), code = typeof response === 'object' && response ? (response as { code?: unknown }).code : undefined;
    if (typeof code === 'string') return { code, source: 'http' };
  }
  if (error instanceof LiveBoundaryError) return { code: error.code, source: 'boundary' };
  if (error instanceof Error && CODE.test(error.message)) return { code: error.message, source: 'message' };
  return { code: null, source: 'unknown' };
}

export function classify(error: unknown, depth = 0): ErrorClassification {
  const { code, source } = own(error);
  if (code !== null && WRAPPING_CODES.has(code) && depth < 3 && error instanceof Error && error.cause !== undefined) {
    const inner = classify(error.cause, depth + 1);
    if (inner.class === 'budget') return { class: 'budget', code, source, ...(inner.retryAfterMs !== undefined ? { retryAfterMs: inner.retryAfterMs } : {}) };
  }
  if (error instanceof StepWait) return { class: 'budget', code, source, retryAfterMs: error.retryMs };
  if (error instanceof StepFail) return { class: 'permanent', code, source };
  // Its estimate, at least 1 s: a local bucket's, or the shared window's (when
  // its charges ahead expire, sharedCapacityWait; 65 s when it can't say).
  if (error instanceof HyperliquidBudgetWait) return { class: 'budget', code, source, retryAfterMs: Math.max(1_000, error.retryMs) };
  if (code !== null && BUDGET_CODES.has(code)) {
    // A meter refusal that says when the weight fits is retried then.
    const retryAfterMs = sharedRestRetryAfterMs(error) !== undefined ? sharedCapacityWait(error)!.retryMs : BUDGET_CODES.get(code);
    return { class: 'budget', code, source, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (code !== null && TRANSIENT_WAIT_CODES.has(code)) return { class: 'transient', code, source, exhausts: true };
  if (code !== null && PRIVY_IDENTITY_EVIDENCE_CODES.has(code)) return { class: 'transient', code, source, exhausts: true, exhaustedAs: 'needs_owner' };
  if (code !== null && PERMANENT_CODES.has(code)) return { class: 'permanent', code, source };
  if (code !== null && NEEDS_OWNER_CODES.has(code)) return { class: 'needs_owner', code, source };
  return { class: 'transient', code, source, exhausts: code === null || !UNKNOWN_OUTCOME_CODES.has(code) };
}

/** A transient failure that reached `limit` attempts (counting this one) is permanent. */
export function exhausted(classified: ErrorClassification, attempts: number, limit: number): boolean {
  return classified.class === 'transient' && classified.exhausts !== false && attempts >= limit;
}

/**
 * THE retry policy of a live step (a copy leg, a stop or close, a setup
 * step): how a failure of each class is tried again. One table, so a leg,
 * a stop and a setup step wait the same way for the same failure.
 * - `baseMs`, `maxMs`: a transient failure's back-off, base × 2^attempts,
 *   at most maxMs (a flat delay: maxMs = baseMs).
 * - `attempts`: at this many transient attempts the step ends (`exhausted`),
 *   or, for a code with `exhaustedAs`, waits for its owner.
 * - `needsOwnerMs`: when a step waiting for its owner is looked at again.
 * - `waitDefaultMs`: a wait (`budget`) whose error says no time (a busy
 *   lock, a full queue) is back after this; one that says is back then, at
 *   least WAIT_FLOOR_MS.
 */
export interface RetryPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly attempts: number;
  readonly needsOwnerMs: number;
  readonly waitDefaultMs: number;
}
/** A copy leg's and a stop's policy: 3 s flat, never ended by this count
 * (legs and stops have their own limits: the signal's age, CLOSE_ATTEMPT_LIMIT);
 * a wait without a time is back in a second. */
export const LIVE_LEG_RETRY_POLICY: RetryPolicy = Object.freeze({ baseMs: LIVE_LEG_RETRY_BASE_MS, maxMs: LIVE_LEG_RETRY_BASE_MS, attempts: Number.MAX_SAFE_INTEGER, needsOwnerMs: LIVE_LEG_RETRY_BASE_MS, waitDefaultMs: WAIT_FLOOR_MS });
/** A terminal settlement's policy: a failed pass is tried again after
 * SETTLEMENT_RETRY_MS (flat), a meter wait when the meter says (never an
 * attempt), and at SETTLEMENT_RETRY_ATTEMPTS failed passes it ends: its
 * order goes to its owner (quarantine + ALERT). A settlement that could not
 * prove its order retried every 3 s at live priority for as long as the
 * process ran (gate 11, 2026-10-16: 50+ min, starving the next orders). */
export const SETTLEMENT_RETRY_POLICY: RetryPolicy = Object.freeze({ baseMs: SETTLEMENT_RETRY_MS, maxMs: SETTLEMENT_RETRY_MS, attempts: SETTLEMENT_RETRY_ATTEMPTS, needsOwnerMs: SETTLEMENT_RETRY_MS, waitDefaultMs: LIVE_LEG_RETRY_BASE_MS });
/** A funding confirmation's and a setup abort's policy: their rows back off
 * by their own failure count whatever the class (every failed pass, the
 * explorer unreachable included, doubles the wait: 3 s to 60 s), and have
 * their own exit points (a credit, a block, the not-flat escalation), so
 * only `backoffMs` of it is used. */
export const FUNDING_RETRY_POLICY: RetryPolicy = Object.freeze({ baseMs: SETUP_RETRY_BACKOFF_BASE_MS, maxMs: SETUP_RETRY_BACKOFF_MAX_MS, attempts: Number.MAX_SAFE_INTEGER, needsOwnerMs: SETUP_RETRY_NEEDS_OWNER_MS, waitDefaultMs: SETUP_RETRY_PENDING_MS });

/** THE back-off of a counted failure: `policy.baseMs` × 2^priorAttempts, at
 * most `policy.maxMs` (the exponent is capped so the product stays finite). */
export function backoffMs(priorAttempts: number, policy: RetryPolicy): number {
  return Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(Math.max(priorAttempts, 0), 16));
}

/** What a failed step does next (decideRetry). `delayMs` is from now. */
type RetryDecision =
  /** A wait (`budget`): back when it said, not an attempt. */
  | { readonly kind: 'wait'; readonly delayMs: number; readonly classified: ErrorClassification }
  /** A transient failure, counted: back after its back-off (`attempts`: including this one). */
  | { readonly kind: 'retry'; readonly delayMs: number; readonly attempts: number; readonly classified: ErrorClassification }
  /** The owner's turn (needs_owner, or a transient failure exhausted as such): looked at again after `delayMs`. */
  | { readonly kind: 'owner'; readonly delayMs: number; readonly attempts: number; readonly exhausted: boolean; readonly classified: ErrorClassification }
  /** The step ends (permanent, or a transient failure at the limit). */
  | { readonly kind: 'end'; readonly attempts: number; readonly exhausted: boolean; readonly classified: ErrorClassification };

/**
 * The one decision for a failed live step, from the error's class
 * (classify), the step's attempts so far and the caller's policy:
 * - `budget`: `wait` when the error said (at least WAIT_FLOOR_MS), else
 *   after `policy.waitDefaultMs`; never an attempt.
 * - `needs_owner`: `owner` after `needsOwnerMs`; attempts unchanged.
 * - `permanent`: `end`.
 * - `transient`: one attempt more. At `policy.attempts` (unless the outcome
 *   is still unknown) it is `end`, or `owner` for a code exhausted as such.
 *   Otherwise `retry` after the back-off; a failed provider read
 *   (PROVIDER_READ_FAILURES, a meter refusal code) waits at least
 *   PROVIDER_READ_RETRY_MS whatever the back-off, so failed reads can't
 *   loop into a full connect window (gate 2026-10-13 11:16).
 */
export function decideRetry(error: unknown, priorAttempts: number, policy: RetryPolicy): RetryDecision {
  const classified = classify(error), code = classified.code ?? '';
  switch (classified.class) {
    case 'budget': return { kind: 'wait', delayMs: Math.max(WAIT_FLOOR_MS, classified.retryAfterMs ?? policy.waitDefaultMs), classified };
    case 'needs_owner': return { kind: 'owner', delayMs: policy.needsOwnerMs, attempts: priorAttempts, exhausted: false, classified };
    case 'permanent': return { kind: 'end', attempts: priorAttempts, exhausted: false, classified };
    case 'transient': {
      const attempts = priorAttempts + 1;
      if (exhausted(classified, attempts, policy.attempts)) {
        if (classified.exhaustedAs === 'needs_owner') return { kind: 'owner', delayMs: policy.needsOwnerMs, attempts, exhausted: true, classified };
        return { kind: 'end', attempts, exhausted: true, classified };
      }
      const backoff = backoffMs(priorAttempts, policy);
      const providerRead = PROVIDER_READ_FAILURES.has(code) || code.startsWith('hyperliquid_quota_');
      return { kind: 'retry', delayMs: providerRead ? Math.max(backoff, PROVIDER_READ_RETRY_MS) : backoff, attempts, classified };
    }
  }
}

/**
 * How long a live step that failed waits before it is tried again (a copy
 * leg's next submission, a stop's next pass): decideRetry under
 * LIVE_LEG_RETRY_POLICY, as a delay only (the leg's and the stop's own
 * limits decide when they end).
 */
export function liveRetryDelayMs(error: unknown): number {
  const decision = decideRetry(error, 0, LIVE_LEG_RETRY_POLICY);
  return decision.kind === 'end' ? LIVE_LEG_RETRY_POLICY.baseMs : decision.delayMs;
}
