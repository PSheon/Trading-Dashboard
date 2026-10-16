import { decideRetry, SETTLEMENT_RETRY_POLICY, type RetryPolicy } from '../live/error-class.js';
import { LiveBoundaryError } from '../live/wallet-authorization.js';
import type { LiveSettleOutcome } from './copy-live-settler.js';

/** The dispatch's and the reservation's reason once a settlement's retries are over. */
export const SETTLEMENT_NEEDS_OWNER = 'live_settlement_needs_owner';

/** Pending reasons that are waits with a bound of their own (the never-placed
 * grace; an order not terminal yet): never a failed pass. */
const BOUNDED_WAITS: ReadonlySet<string> = new Set(['live_settlement_never_placed_grace', 'live_settlement_not_terminal']);

/** What a settlement does after a pass that did not settle it. */
export type SettlementVerdict =
  /** Its next pass, not before `delayMs` (a meter wait is not an attempt). */
  | { readonly kind: 'retry'; readonly delayMs: number; readonly attempts: number }
  /** Its retries are over: its order goes to its owner (quarantine + ALERT). */
  | { readonly kind: 'needs_owner'; readonly attempts: number; readonly code: string };

/**
 * A terminal settlement's failed passes, per order key, under
 * SETTLEMENT_RETRY_POLICY (decideRetry): when its next pass is due, and once
 * its retries are over (needs_owner), that its order goes to its owner
 * instead of being settled again. Before, a settlement that could not prove
 * its order (a stop had closed its position) retried every 3 s at live
 * priority for as long as the process ran (gate 11, 2026-10-16).
 * In memory: a restart counts again from 0 (bounded the same way).
 */
export class SettlementRetries {
  private readonly rows = new Map<string, { attempts: number; at: number; owner: boolean }>();
  constructor(private readonly now: () => number = Date.now, private readonly policy: RetryPolicy = SETTLEMENT_RETRY_POLICY) {}
  /** Whether `key`'s next pass is due. */
  due(key: string): boolean { return (this.rows.get(key)?.at ?? Number.NEGATIVE_INFINITY) <= this.now(); }
  /** Whether `key`'s retries are over: its pass quarantines, it settles nothing. */
  owed(key: string): boolean { return this.rows.get(key)?.owner === true; }
  /** `key` settled, or ended some other way: forgotten. */
  done(key: string): void { this.rows.delete(key); }
  /** A pass that threw `error`. */
  failed(key: string, error: unknown): SettlementVerdict {
    const prior = this.rows.get(key), attempts = prior?.attempts ?? 0, decision = decideRetry(error, attempts, this.policy);
    this.prune();
    if (decision.kind === 'end' || decision.kind === 'owner') {
      this.rows.set(key, { attempts: decision.attempts, at: this.now(), owner: true });
      return { kind: 'needs_owner', attempts: decision.attempts, code: decision.classified.code ?? 'unknown' };
    }
    const next = decision.kind === 'retry' ? decision.attempts : attempts;
    this.rows.set(key, { attempts: next, at: this.now() + decision.delayMs, owner: false });
    return { kind: 'retry', delayMs: decision.delayMs, attempts: next };
  }
  /** A pass's outcome: one that settled or ended is forgotten; a `pending` one
   * counts as a failed pass (unless it is a bounded wait), as a thrown error would. */
  outcome(key: string, outcome: LiveSettleOutcome): SettlementVerdict | null {
    if (outcome.kind !== 'pending') { this.done(key); return null; }
    if (BOUNDED_WAITS.has(outcome.reason)) return null;
    return this.failed(key, new LiveBoundaryError(outcome.reason));
  }
  /** Keys not seen for 10 retry intervals past due are dropped (settled elsewhere). */
  private prune(): void {
    if (this.rows.size < 1024) return;
    const stale = this.now() - 10 * this.policy.maxMs;
    for (const [key, row] of this.rows) if (!row.owner && row.at < stale) this.rows.delete(key);
  }
}
