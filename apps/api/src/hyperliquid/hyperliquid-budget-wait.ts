import { ServiceUnavailableException } from '@nestjs/common';
import { HyperliquidRestCapacityError, sharedRestRetryAfterMs } from './hyperliquid-capacity-error.js';
import { LiveBoundaryError } from '../copy/live/wallet-authorization.js';
import { BudgetWaitError, LIVE_YIELD_RANK, type RequestBudgeterService, type RequestPriority } from './request-budgeter.service.js';

/** After the shared per-IP window refused a charge without saying when it
 * fits: no sooner than this (the provider's 60 s window plus the 5 s send
 * window of the charges in it). A refusal that says when
 * (HyperliquidRestCapacityError.retryAfterMs) is retried then. */
export const SHARED_CAPACITY_RETRY_MS = 65_000;
/** Earliest retry after a shared-window refusal, and what is added to the
 * meter's estimate (its clock and ours, the next charge's transaction). */
export const SHARED_CAPACITY_MIN_RETRY_MS = 1_000;
const SHARED_CAPACITY_SLACK_MS = 250;
/** Longest a setup step's read waits for its Hyperliquid weight before it
 * starts its evidence clock (a reservation the step's client queues waits up
 * to AppConfig.copy.live.setup.stepBudgetMs.reserveWaitMs, live-timings.ts). */
export const LIVE_RESERVE_WAIT_MS = 8_000;
/** What `reserveLive` adds to a wait it allows: the estimate is a hint (a
 * background turn or a 429 backoff can make it longer). */
const WAIT_SLACK_MS = 1_000;

/** What a throw site knows about a wait, for the log and the setup's
 * `last_wait` (never part of the HTTP answer): the weight asked for, its
 * lane, which bucket, what that bucket held and how many calls waited on it. */
export interface BudgetWaitDetail {
  readonly weight?: number; readonly lane?: RequestPriority; readonly bucket?: string; readonly tokens?: number; readonly queued?: number;
}
/** The detail of a wait on `budget` for `weight` (read when it is refused). */
const waitDetail = (budget: RequestBudgeterService, weight: number, lane: RequestPriority, bucket?: string): BudgetWaitDetail => {
  const detail: BudgetWaitDetail = { weight, lane, ...(bucket ? { bucket } : {}) };
  // Diagnostics only: a budget that can't say more never turns the wait into a crash.
  try {
    const queued = budget.queued();
    return { ...detail, tokens: Math.floor(budget.introspect().tokensAvailable), queued: queued.live + queued.background };
  } catch { return detail; }
};

/**
 * A Hyperliquid step was not started because its weight is not available
 * yet: in this process's token bucket (`local_budget`) or in the shared
 * per-IP meter (`shared_capacity`). Nothing was read or sent. `retryMs` is
 * when to try again. Thrown before any evidence window opens, so a busy
 * budget never turns into stale evidence (the setup stall of 2026-10-05).
 */
export class HyperliquidBudgetWait extends ServiceUnavailableException {
  constructor(readonly retryMs: number, readonly reason: 'local_budget' | 'shared_capacity', readonly detail: BudgetWaitDetail = {}) {
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

/** The shared meter refused a REST charge: a wait until the meter said the
 * weight fits (its charges ahead expire; at least 1 s), or 65 s when it
 * could not say. A fixed 65 s kept a setup's mode step waiting out whole
 * windows for 10 minutes (2026-10-13). */
export function sharedCapacityWait(error: unknown): HyperliquidBudgetWait | undefined {
  if (error instanceof HyperliquidBudgetWait) return error;
  const retry = sharedRestRetryAfterMs(error);
  if (retry !== undefined)
    return new HyperliquidBudgetWait(Math.min(SHARED_CAPACITY_RETRY_MS, Math.max(SHARED_CAPACITY_MIN_RETRY_MS, retry + SHARED_CAPACITY_SLACK_MS)), 'shared_capacity');
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
  /** `live` only: wait in line for up to `maxWaitMs` even when the estimate
   * says longer, instead of refusing at once. A waiter at the head of the
   * live lane has the refill build up for it; refused, it comes back to a
   * bucket background work drained meanwhile (a 613 account-mode
   * reservation never fit 8 s: the mainnet setup loop of 2026-10-12). */
  readonly queue?: boolean;
  /** Which bucket, for a refusal's detail (logs, the setup's `last_wait`). */
  readonly bucket?: string;
  /** `reserve` only (live lane): the reservation keeps its place in the
   * bucket's live queue under this key when its caller stops waiting
   * (`maxWaitMs`). It yields to every other live call (LIVE_YIELD_RANK):
   * the refill builds up for it only while no unkeyed live call waits, and
   * holds among themselves go in arrival order; the caller's next pass with
   * the same key takes it over (or what it gathered once it is whole). A
   * hold never sits ahead of a live order, its source read or its
   * observation (gate 2026-10-13 11:13). A copy setup's account-mode
   * attempt (715) waited 15 s on a bucket other live work kept at ~500,
   * gave up its place, and came back to the same ~500 (gate 2026-10-13,
   * `local_budget` 613, tokens 524–575). Abandoned after LOCAL_HOLD_IDLE_MS
   * without a caller; gathered but not taken, refunded after LOCAL_HOLD_READY_MS. */
  readonly holdKey?: string;
}
/** Weight taken from a token bucket before a read starts its clock. */
export interface LiveBudgetReservation {
  /** Conservative dispatch boundary: once consumed, even unknown outcomes stay charged. */
  consume(weight: number): void;
  /** Refund only weight never consumed; idempotent. */
  release(): void;
  /** A keyed reservation (`holdKey`) not used at all: kept for the key's next
   * pass instead of refunded (LOCAL_HOLD_READY_MS at most). Ends this handle
   * like `release`. */
  park?(): void;
}
export type LiveBudget = ((weight: number, options?: LiveReserveOptions) => Promise<unknown>) & {
  reserve?(weight: number, options?: LiveReserveOptions): Promise<LiveBudgetReservation>;
};

/**
 * THE way copy and wallet code takes Hyperliquid weight from a token bucket
 * before a read or an action (one wrapper instead of a dozen ad-hoc
 * `budget.acquire(…, { signal: AbortSignal.timeout(5000) })`).
 *
 * - A `live` reservation heavier than the bucket's capacity fails at once
 *   (`HyperliquidBudgetOverCapacity`, code `live_budget_over_capacity`).
 * - When the bucket can't give it within `maxWaitMs`, nothing is taken and a
 *   `HyperliquidBudgetWait` says when it can: at once when the estimate
 *   already says so (`live`, unless `queue`), else once the wait runs out.
 *   Never a bare `TimeoutError`.
 * - The caller's own `signal` aborting is passed through as it is.
 */
export async function reserveLive(budget: RequestBudgeterService, weight: number, { maxWaitMs, signal, lane = 'live', queue = false, bucket }: LiveReserveOptions = {}): Promise<void> {
  signal?.throwIfAborted();
  if (lane === 'live' && weight > budget.liveCapacity) throw new HyperliquidBudgetOverCapacity(weight, budget.liveCapacity);
  const limit = maxWaitMs ?? budget.refillMs();
  if (lane === 'live' && !queue) {
    const estimate = budget.liveWaitMs(weight);
    if (estimate > limit) throw new HyperliquidBudgetWait(estimate, 'local_budget', waitDetail(budget, weight, lane, bucket));
  }
  const timeout = AbortSignal.timeout(Math.max(1, limit) + WAIT_SLACK_MS);
  try { await budget.acquire(weight, lane, lane === 'live' ? 0 : undefined, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
  catch (error) {
    if (signal?.aborted) throw error;
    // A wait that ran out (ours or the consumer's queue deadline), or a full
    // queue: come back later. Anything else (the budgeter stopping with the
    // process) is not a wait.
    if (!timeout.aborted && !(error instanceof BudgetWaitError) && !(error instanceof Error && error.message === 'Hyperliquid queue is full')) throw error;
    throw new HyperliquidBudgetWait(Math.max(1_000, lane === 'live' ? budget.liveWaitMs(weight) : budget.refillMs(weight)), 'local_budget', waitDetail(budget, weight, lane, bucket));
  }
}

/** A keyed live reservation (`holdKey`) waiting with nobody asking for it is
 * abandoned after this (its caller comes back at least every 20 s). */
export const LOCAL_HOLD_IDLE_MS = 60_000;
/** A keyed reservation whose weight is gathered (or parked) but not taken is
 * refunded after this. */
export const LOCAL_HOLD_READY_MS = 30_000;
/** Longest a keyed reservation's refusal asks its caller to stay away (well
 * inside LOCAL_HOLD_IDLE_MS). */
const LOCAL_HOLD_RETRY_MS = 15_000;
interface LocalHold { readonly weight: number; ready: boolean; readonly gathered: Promise<void>; readonly abort: AbortController; timer?: ReturnType<typeof setTimeout> }
const localHolds = new WeakMap<RequestBudgeterService, Map<string, LocalHold>>();
/** Keyed holds of a bucket (tests, diagnostics). */
export const localHoldKeys = (budget: RequestBudgeterService): string[] => [...(localHolds.get(budget)?.keys() ?? [])];

/** A tracked live reservation of `weight` taken from `budget`. `park`: put back under `key`. */
function trackedReservation(budget: RequestBudgeterService, weight: number, key?: string): LiveBudgetReservation {
  let unused = weight, released = false;
  return {
    consume(cost) {
      if (released || !Number.isSafeInteger(cost) || cost < 1 || cost > unused) throw new Error('Invalid reservation consumption');
      unused -= cost;
    },
    release() {
      if (released) return;
      released = true;
      if (unused > 0) budget.refundLive(unused);
      unused = 0;
    },
    ...(key === undefined ? {} : { park() {
      if (released) return;
      released = true;
      if (unused !== weight) { if (unused > 0) budget.refundLive(unused); return; }
      parkHold(budget, key, weight);
    } }),
  };
}

function holdsOf(budget: RequestBudgeterService): Map<string, LocalHold> {
  let map = localHolds.get(budget);
  if (!map) { map = new Map(); localHolds.set(budget, map); }
  return map;
}
/** Ends a hold: a gathered one's weight goes back to the bucket, a waiting one leaves the queue. */
function dropHold(budget: RequestBudgeterService, key: string, hold: LocalHold): void {
  const map = holdsOf(budget);
  if (map.get(key) !== hold) return;
  map.delete(key); clearTimeout(hold.timer);
  if (hold.ready) budget.refundLive(hold.weight); else hold.abort.abort(new Error('Local hold abandoned'));
}
function arm(budget: RequestBudgeterService, key: string, hold: LocalHold, ms: number): void {
  clearTimeout(hold.timer);
  hold.timer = setTimeout(() => dropHold(budget, key, hold), ms);
  hold.timer.unref?.();
}
/** Gathered weight nobody took yet, kept for `key`'s next pass. */
function parkHold(budget: RequestBudgeterService, key: string, weight: number): void {
  const map = holdsOf(budget), prior = map.get(key);
  if (prior) dropHold(budget, key, prior);
  const hold: LocalHold = { weight, ready: true, gathered: Promise.resolve(), abort: new AbortController() };
  map.set(key, hold); arm(budget, key, hold, LOCAL_HOLD_READY_MS);
}

/**
 * `reserve` with a `holdKey`: the weight is gathered in the bucket's live
 * queue behind every other live call (LIVE_YIELD_RANK: the refill builds up
 * for it while none waits; holds go in arrival order among themselves), and
 * keeps its place there when the caller stops waiting after
 * `maxWaitMs`: the refusal (`local_budget`, retry within LOCAL_HOLD_RETRY_MS)
 * says when to come back, and the same key's next call takes over what was
 * gathered. A wait never runs out with the place lost.
 */
async function reserveHeld(budget: RequestBudgeterService, weight: number, key: string, { maxWaitMs, signal, bucket }: LiveReserveOptions): Promise<LiveBudgetReservation> {
  signal?.throwIfAborted();
  if (weight > budget.liveCapacity) throw new HyperliquidBudgetOverCapacity(weight, budget.liveCapacity);
  const map = holdsOf(budget);
  let hold = map.get(key);
  if (hold && hold.weight !== weight) { dropHold(budget, key, hold); hold = undefined; }
  if (!hold) {
    const abort = new AbortController();
    const created: LocalHold = { weight, ready: false, abort, gathered: budget.acquire(weight, 'live', LIVE_YIELD_RANK, { signal: abort.signal }).then(() => {
      created.ready = true;
      if (map.get(key) === created) arm(budget, key, created, LOCAL_HOLD_READY_MS);
      // Gathered after its holder left the map (dropped meanwhile): give it back.
      else budget.refundLive(weight);
    }) };
    created.gathered.catch(() => { if (map.get(key) === created) { map.delete(key); clearTimeout(created.timer); } });
    hold = created; map.set(key, hold);
  }
  if (!hold.ready) arm(budget, key, hold, LOCAL_HOLD_IDLE_MS);
  const current = hold, limit = maxWaitMs ?? budget.refillMs();
  let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
  const outcome = await Promise.race([
    current.gathered.then(() => 'ready' as const, () => 'gone' as const),
    new Promise<'waiting'>(resolve => { timer = setTimeout(() => resolve('waiting'), Math.max(1, limit)); }),
    new Promise<'aborted'>(resolve => { onAbort = () => resolve('aborted'); signal?.addEventListener('abort', onAbort, { once: true }); }),
  ]).finally(() => { clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort); });
  if (outcome === 'aborted') signal!.throwIfAborted();
  if (outcome === 'ready' && map.get(key) === current) {
    map.delete(key); clearTimeout(current.timer);
    return trackedReservation(budget, weight, key);
  }
  // Still gathering (or ended under us): come back; its place is kept.
  const estimate = budget.liveWaitMs(0, LIVE_YIELD_RANK);
  throw new HyperliquidBudgetWait(Math.min(LOCAL_HOLD_RETRY_MS, Math.max(1_000, estimate)), 'local_budget', waitDetail(budget, weight, 'live', bucket));
}

/** Binds `reserveLive` to one bucket, with defaults a caller's options override. */
export const liveBudget = (budget: RequestBudgeterService, defaults: LiveReserveOptions = {}): LiveBudget => {
  const acquire: LiveBudget = (weight, options) => reserveLive(budget, weight, { ...defaults, ...options });
  acquire.reserve = async (weight, options) => {
    // Background reservations have page bookkeeping and remain conventional.
    if ((options?.lane ?? defaults.lane ?? 'live') !== 'live') throw new Error('Tracked reservation requires live lane');
    const merged = { ...defaults, ...options };
    if (merged.holdKey !== undefined) return reserveHeld(budget, weight, merged.holdKey, merged);
    await acquire(weight, options);
    return trackedReservation(budget, weight);
  };
  return acquire;
};

/**
 * Startup check: `budget` can ever hold `weight` (its live capacity), or
 * every such reservation would fail with live_budget_over_capacity. Throws a
 * clear error to refuse startup.
 */
export function assertBucketHolds(budget: RequestBudgeterService, weight: number, what: string, fix: string): void {
  if (weight > budget.liveCapacity) throw new Error(`${what} weighs ${weight}, more than this process's Hyperliquid bucket can hold (${budget.liveCapacity}: min(burst, 1200 − rate)). ${fix}`);
}
