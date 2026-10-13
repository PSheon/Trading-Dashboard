import { HttpException } from '@nestjs/common';
import { HyperliquidBudgetWait, SHARED_CAPACITY_RETRY_MS } from '../../hyperliquid/hyperliquid-budget-wait.js';
import { LiveBoundaryError } from './wallet-authorization.js';

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
export type ErrorClass = 'budget' | 'transient' | 'permanent' | 'needs_owner';

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
]);
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
]);
/** Waits, not failures: a read that was stale or could not be had, or the
 * worker's signer not up yet. Unlisted codes are `transient` already; these
 * are named so no one moves them to a blocking class by accident (a setup
 * abort shows them as waiting, never as needing action). */
export const TRANSIENT_WAIT_CODES: ReadonlySet<string> = new Set([
  'setup_abort_evidence_unavailable', 'setup_abort_proof_stale', 'setup_abort_proof_not_flat', 'setup_abort_lease_changed', 'setup_abort_unavailable',
]);
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

export function classify(error: unknown): ErrorClassification {
  const { code, source } = own(error);
  if (error instanceof StepWait) return { class: 'budget', code, source, retryAfterMs: error.retryMs };
  if (error instanceof StepFail) return { class: 'permanent', code, source };
  // The shared window: no sooner than its 65 s; a local bucket: its estimate, at least 1 s.
  if (error instanceof HyperliquidBudgetWait) return { class: 'budget', code, source,
    retryAfterMs: error.reason === 'shared_capacity' ? Math.max(SHARED_CAPACITY_RETRY_MS, error.retryMs) : Math.max(1_000, error.retryMs) };
  if (code !== null && BUDGET_CODES.has(code)) {
    const retryAfterMs = BUDGET_CODES.get(code);
    return { class: 'budget', code, source, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (code !== null && TRANSIENT_WAIT_CODES.has(code)) return { class: 'transient', code, source, exhausts: true };
  if (code !== null && PERMANENT_CODES.has(code)) return { class: 'permanent', code, source };
  if (code !== null && NEEDS_OWNER_CODES.has(code)) return { class: 'needs_owner', code, source };
  return { class: 'transient', code, source, exhausts: code === null || !UNKNOWN_OUTCOME_CODES.has(code) };
}

/** A transient failure that reached `limit` attempts (counting this one) is permanent. */
export function exhausted(classified: ErrorClassification, attempts: number, limit: number): boolean {
  return classified.class === 'transient' && classified.exhausts !== false && attempts >= limit;
}
