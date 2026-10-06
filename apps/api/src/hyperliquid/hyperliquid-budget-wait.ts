import { ServiceUnavailableException } from '@nestjs/common';
import { HyperliquidRestCapacityError } from './hyperliquid-capacity-error.js';
import { LiveBoundaryError } from '../copy/live/wallet-authorization.js';
import { BudgetWaitError, type RequestBudgeterService, type RequestPriority } from './request-budgeter.service.js';

/** After the shared per-IP window refused a charge: no sooner than this (the
 * provider's 60 s window plus the 5 s send window of the charges in it). */
export const SHARED_CAPACITY_RETRY_MS = 65_000;
/** Longest a setup step waits for its Hyperliquid weight before it starts its
 * evidence clock. Several of these fit in a setup driver's 60 s lease. */
export const LIVE_RESERVE_WAIT_MS = 8_000;
/** What `reserveLive` adds to a wait it allows: the estimate is a hint (a
 * background turn or a 429 backoff can make it longer). */
const WAIT_SLACK_MS = 1_000;

/**
 * A Hyperliquid step was not started because its weight is not available
 * yet: in this process's token bucket (`local_budget`) or in the shared
 * per-IP meter (`shared_capacity`). Nothing was read or sent. `retryMs` is
 * when to try again. Thrown before any evidence window opens, so a busy
 * budget never turns into stale evidence (the setup stall of 2026-10-05).
 */
export class HyperliquidBudgetWait extends ServiceUnavailableException {
  constructor(readonly retryMs: number, readonly reason: 'local_budget' | 'shared_capacity') {
    super({ statusCode: 503, code: 'hyperliquid_busy', message: 'Hyperliquid is busy; try again shortly', retryAfterMs: Math.ceil(retryMs) });
  }
}

/**
 * A `live` reservation heavier than the bucket can ever hold at once (its
 * whole burst). It would wait for a full bucket and still not fit, so it
 * fails at once instead of waiting: no retry helps until the configuration
 * (the bucket, or the copies an owner may hold) changes. On Stage on
 * 2026-10-06 every order of an owner with three accounts (772) waited on a
 * 500 bucket until a 5 s timeout, as a bare TimeoutError.
 */
export class HyperliquidBudgetOverCapacity extends LiveBoundaryError {
  constructor(readonly weight: number, readonly capacity: number) { super('live_budget_over_capacity'); }
}

/** The shared meter refused a REST charge: a wait of at least 65 s. */
export function sharedCapacityWait(error: unknown): HyperliquidBudgetWait | undefined {
  if (error instanceof HyperliquidBudgetWait) return error;
  if (error instanceof HyperliquidRestCapacityError || error instanceof LiveBoundaryError && error.code === 'hyperliquid_quota_exhausted')
    return new HyperliquidBudgetWait(SHARED_CAPACITY_RETRY_MS, 'shared_capacity');
  return undefined;
}

export interface LiveReserveOptions {
  /** Longest wait allowed. Default: the time the bucket takes to refill
   * completely at its current rate (never a fixed few seconds: a heavy
   * reservation on a slow bucket needs that long, and a shorter timeout
   * failed every order). */
  readonly maxWaitMs?: number;
  readonly signal?: AbortSignal;
  /** `live` (default): latency-sensitive copy and wallet work, first in line;
   * `background`: work nobody waits for (follower snapshots, receipts). */
  readonly lane?: RequestPriority;
}
/** Weight taken from a token bucket before a read starts its clock. */
export type LiveBudget = (weight: number, options?: LiveReserveOptions) => Promise<unknown>;

/**
 * THE way copy and wallet code takes Hyperliquid weight from a token bucket
 * before a read or an action (one wrapper instead of a dozen ad-hoc
 * `budget.acquire(…, { signal: AbortSignal.timeout(5000) })`).
 *
 * - A `live` reservation heavier than the bucket's capacity fails at once
 *   (`HyperliquidBudgetOverCapacity`, code `live_budget_over_capacity`).
 * - When the bucket can't give it within `maxWaitMs`, nothing is taken and a
 *   `HyperliquidBudgetWait` says when it can: at once when the estimate
 *   already says so (`live`), else once the wait runs out. Never a bare
 *   `TimeoutError`.
 * - The caller's own `signal` aborting is passed through as it is.
 */
export async function reserveLive(budget: RequestBudgeterService, weight: number, { maxWaitMs, signal, lane = 'live' }: LiveReserveOptions = {}): Promise<void> {
  signal?.throwIfAborted();
  if (lane === 'live' && weight > budget.liveCapacity) throw new HyperliquidBudgetOverCapacity(weight, budget.liveCapacity);
  const limit = maxWaitMs ?? budget.refillMs();
  if (lane === 'live') {
    const estimate = budget.liveWaitMs(weight);
    if (estimate > limit) throw new HyperliquidBudgetWait(estimate, 'local_budget');
  }
  const timeout = AbortSignal.timeout(Math.max(1, limit) + WAIT_SLACK_MS);
  try { await budget.acquire(weight, lane, lane === 'live' ? 0 : undefined, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
  catch (error) {
    if (signal?.aborted) throw error;
    // A wait that ran out (ours or the consumer's queue deadline), or a full
    // queue: come back later. Anything else (the budgeter stopping with the
    // process) is not a wait.
    if (!timeout.aborted && !(error instanceof BudgetWaitError) && !(error instanceof Error && error.message === 'Hyperliquid queue is full')) throw error;
    throw new HyperliquidBudgetWait(Math.max(1_000, lane === 'live' ? budget.liveWaitMs(weight) : budget.refillMs(weight)), 'local_budget');
  }
}

/** Binds `reserveLive` to one bucket, with defaults a caller's options override. */
export const liveBudget = (budget: RequestBudgeterService, defaults: LiveReserveOptions = {}): LiveBudget =>
  (weight, options) => reserveLive(budget, weight, { ...defaults, ...options });
