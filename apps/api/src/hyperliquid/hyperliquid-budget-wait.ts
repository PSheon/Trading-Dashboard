import { ServiceUnavailableException } from '@nestjs/common';
import { HyperliquidRestCapacityError } from './hyperliquid-capacity-error.js';
import { LiveBoundaryError } from '../copy/live/wallet-authorization.js';
import type { RequestBudgeterService } from './request-budgeter.service.js';

/** After the shared per-IP window refused a charge: no sooner than this (the
 * provider's 60 s window plus the 5 s send window of the charges in it). */
export const SHARED_CAPACITY_RETRY_MS = 65_000;
/** Longest a step waits for its Hyperliquid weight before it starts its
 * evidence clock. Several of these fit in a setup driver's 60 s lease. */
export const LIVE_RESERVE_WAIT_MS = 8_000;

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

/** The shared meter refused a REST charge: a wait of at least 65 s. */
export function sharedCapacityWait(error: unknown): HyperliquidBudgetWait | undefined {
  if (error instanceof HyperliquidBudgetWait) return error;
  if (error instanceof HyperliquidRestCapacityError || error instanceof LiveBoundaryError && error.code === 'hyperliquid_quota_exhausted')
    return new HyperliquidBudgetWait(SHARED_CAPACITY_RETRY_MS, 'shared_capacity');
  return undefined;
}

export interface LiveReserveOptions { readonly maxWaitMs?: number; readonly signal?: AbortSignal }
/** Weight taken from a token bucket before a read starts its clock. */
export type LiveBudget = (weight: number, options?: LiveReserveOptions) => Promise<unknown>;

/**
 * Takes `weight` from `budget`'s live lane, waiting at most `maxWaitMs`.
 * When the bucket can't give it that soon, nothing is taken and a
 * `HyperliquidBudgetWait` says when it can.
 */
export async function reserveLive(budget: RequestBudgeterService, weight: number, { maxWaitMs = LIVE_RESERVE_WAIT_MS, signal }: LiveReserveOptions = {}): Promise<void> {
  signal?.throwIfAborted();
  const estimate = budget.liveWaitMs(weight);
  if (estimate > maxWaitMs) throw new HyperliquidBudgetWait(estimate, 'local_budget');
  const timeout = AbortSignal.timeout(Math.max(1, maxWaitMs) + 1_000);
  try { await budget.acquire(weight, 'live', 0, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new HyperliquidBudgetWait(Math.max(1_000, budget.liveWaitMs(weight)), 'local_budget');
  }
}
