import { AsyncLocalStorage } from "node:async_hooks";

import { AppConfig } from "../config/app-config.js";
import { Injectable, Logger } from "@nestjs/common";
import { currentRequestAnswered, currentRequestClient } from "../runtime/request-context.js";


/**
 * Shared request-weight budgeter for every Hyperliquid `info` call (W6,
 * §4.2/§8). Every REST call goes through `acquire()` before it hits the
 * network.
 *
 * Limits (hyperliquid.gitbook.io, rate-limits-and-user-limits): 1200
 * weight/minute per IP; `clearinghouseState` weighs 2; `userFillsByTime`
 * weighs 20 plus a surcharge per 20 items returned. The docs don't give the
 * surcharge multiplier; this codebase assumes +1 per 20 items (so a full
 * 2000-row page costs 120), which is the common reading.
 *
 * Load shape: fill discovery comes from the `trades` WS feed, which costs no
 * REST weight. REST carries (a) the odd `clearinghouseState` the feed fast
 * path needs, (b) a `userFillsByTime` per address that traded, a few seconds
 * later, to store its fills, (c) the 5-minute snapshots, (d) the hourly
 * sweep, (e) A5 backfill, (f) the discovery pool, cohort and history jobs
 * and (g) page loads. (a) is latency-sensitive, and so are copy trading's
 * reads: its mids and leader account values, and (b), (d) for an address
 * someone copies (its fills are copy signals, refused when stale). Those
 * run in the `live` lane; everything else is `background`. The default
 * rate is PRD §8's 70% of 1200.
 *
 * ## Design
 *
 * Two token buckets fed by one refill at the budget rate, so any 60 s
 * carries at most rate + burst (`HYPERLIQUID_WEIGHT_BURST`, capped so that
 * stays under Hyperliquid's 1200):
 *
 * - the **page reserve** (`PAGE_RESERVE_CAPACITY_SHARE` of the burst): only
 *   `live` calls and interactive page calls (background ranks ≤
 *   `INTERACTIVE_MAX_RANK`: a trader page's first paint and its chart)
 *   may spend it, and the refill fills it first (half of it while
 *   main-bucket work waits, see `refill`). Background jobs can't
 *   consume it, however full their queues and however deep in debt the
 *   main bucket is, so a cold profile + portfolio read (≈ 130 weight) goes
 *   out at once while backfill, sweeps and pool builds are queued behind
 *   heavy fill lists. While page work is over its share of the minute
 *   (`PAGE_SHARE`), the reserve refills at only `pageReserveShare` of the
 *   rate and interactive calls may spend nothing else: that share is the
 *   hard floor pages always get, and the rest of the budget goes to
 *   everything else;
 * - the **main bucket** (the rest of the burst): everything else, with the
 *   last `LIVE_RESERVE_SHARE` of it kept for `live`. Background lists take
 *   it into debt (a call heavier than what it may use waits for all of it,
 *   then runs); the debt is paid from the main bucket's refill only, never
 *   from the reserve's.
 *
 * - `live` waiters go before `background` ones and spend the reserve
 *   first, then the main bucket: a background list's debt never holds
 *   the watcher, and the watcher never eats what a background call is
 *   saving up for.
 * - Starvation guard: while `background` waiters exist, at least one in
 *   every four dispatches goes to `background`.
 * - Within a lane the lowest `rank` goes first; the lowest-ranked waiter is
 *   served first even when a later one would fit now, so a heavy page call
 *   isn't starved by a stream of small background calls: the tokens build
 *   up for it.
 *
 * ## Page loads (Stage 2 §10 cold trader pages)
 *
 * Trader-page calls are `background` with ranks 0–3 (`PAGE_RANK`): the
 * profile (first paint) 0, portfolio 1, fills/activity 2, home warm-up 3.
 * Every other background call without an explicit rank gets
 * `UNRANKED_BASE + arrival`, so it always sorts behind them.
 *
 * ## On-demand page work (anyone can ask for any address)
 *
 * Page work is a background call at a page rank up to `PAGE_RANK.fills`
 * (trader pages, sparklines, cold trade analytics). A caller chooses what
 * it costs, so it is bounded apart from the work the product runs on:
 *
 * - Page waiters don't count against the 1000-waiter queue limit, so a
 *   flood of them can't get the watcher's live calls refused.
 * - At most `pageQueueMax` page weight may wait at once (30 s of budget
 *   plus a bucket) and at most half of that per client (`clientKey`, read
 *   from the request context); beyond it `acquire` fails at once with
 *   `PageBusyError` (the pages answer 503 busy). A list call counts its
 *   known base, not its worst case, so one cold trader page (~160) always
 *   fits a client's share.
 * - While page work has spent `PAGE_SHARE` of the budget in the trailing
 *   minute, a waiting non-page background call (fill storage behind
 *   alerts, snapshots, sweeps) goes first in the main bucket and
 *   interactive calls live on the reserve's guaranteed share. Below the
 *   share page work keeps its priority, and with nothing else waiting it
 *   may use everything.
 * - A page waiter made inside an HTTP request is dropped once that request
 *   has been answered or abandoned (`currentRequestAnswered`).
 *
 * ## Consumers (who spends the budget)
 *
 * A job wraps its work in `budgetConsumer(label, …)`; every call made
 * inside is accounted to that label (`introspect().consumers`, on
 * `/health`). Page work is "page" and the live lane "live" unless labelled.
 *
 * - **Caps.** `setConsumerCaps` gives a label a weight-per-minute cap (the
 *   admin's discovery settings: the pool's two loops, the cohort loop,
 *   the history job, the backward backfill), enforced here as a token
 *   bucket of one minute: a capped consumer's call waits until its bucket
 *   holds the call's weight (a call heavier than the whole bucket waits for
 *   a full one, then takes it into debt), whatever the main bucket holds.
 *   The configured numbers are maxima: together the caps may take at most
 *   `CAPPED_SHARE` of the *effective* budget, and shrink in proportion when
 *   they would take more — at a smaller `HYPERLIQUID_WEIGHT_BUDGET_PER_MIN`
 *   and after a 429 backoff alike. A call at a page rank is never held by
 *   its consumer's cap (a page that joined a pool computation), only
 *   charged to it.
 * - **Essential work.** Snapshots and sweeps of watched leaders, the
 *   cohort's reads and the watched traders' analytics refresh
 *   (`ESSENTIAL_RANK`) go ahead of every other background
 *   job: behind pages, before the pool, history, backfill and anything
 *   unranked. They are what the product's own figures and alerts rest on,
 *   and they are small; the rest shares what they leave.
 * - **Queue deadline.** `budgetConsumer(label, work, { queueMs })` makes a
 *   call that has waited that long fail (`BudgetWaitError`) instead of
 *   waiting for ever: a periodic job then ends its run, reports it failed
 *   and starts again on its next period.
 *
 * (Until 2026-10-02 the caps were absolute, only two of them were enforced
 * here, and the pool's ranks 999 and 1000 went before all unranked work:
 * with the worker at 360/min the pool took the whole budget for an hour and
 * the 08:35 snapshot run waited in this queue without end.)
 *
 * `backgroundFactor()` tells adaptive jobs how much of their own allowance
 * to use this minute: 1 while page work is within the reserve's share of
 * the budget, falling to `MIN_BACKGROUND_FACTOR` as it reaches
 * `PAGE_SHARE`, so background work yields when page demand rises instead
 * of queueing behind it.
 *
 * A new process starts paced (`HYPERLIQUID_STARTUP_PACE_SECONDS`, default
 * 60): both buckets empty and the refill at `STARTUP_RATE_SHARE` of the
 * rate until that time has passed. A redeploy overlaps the instance it
 * replaces, which is still spending the same IP limit: two full bursts and
 * two full rates at once drew a 429 on 2026-10-02.
 *
 * On a real 429 the rate halves (floor 20% of the budget) and both buckets
 * empty, the main one 2 s into debt; the rate recovers by 10% of the budget
 * per 20 consecutive successes. List endpoints (`userFills`,
 * `userFillsByTime`, TWAP slices) cost 1 more per 20 items returned, known
 * only afterwards: the client acquires the worst case up front and
 * `adjust()`s the main bucket by the difference once the response is in.
 * Background lists wait for their whole worst case; a page's list (rank ≤
 * `PAGE_RANK.fills`) waits only for its known base plus the reserves, then
 * takes the worst case; the next page list within `PAGE_LIST_GRACE_MS` is
 * not held behind that worst case (the real cost is settled within a
 * second), so a cold page's two fill lists go out back to back and the
 * exposure beyond budget + burst stays at one list's surcharge (100).
 */
export type RequestPriority = "live" | "background";

/** Hyperliquid's documented REST limit per IP. */
const HARD_LIMIT_PER_MIN = 1200;
/** Share of the main bucket only `live` may spend. */
const LIVE_RESERVE_SHARE = 0.1;
/** Share of the burst that is the page reserve (first paint + chart of a
 * cold trader page ≈ 106–130 weight at 200 burst → 120). */
export const PAGE_RESERVE_CAPACITY_SHARE = 0.6;
/** Live dispatches in a row, while background waits, before one background. */
const MAX_LIVE_STREAK = 3;
/** A page list's worst-case surcharge is forgiven in the next page list's
 * gate for this long (its real cost is settled within a second), so a cold
 * page's second fill list doesn't wait out the first one's worst case.
 * One list at a time: at most 100 weight of exposure beyond budget + burst. */
const PAGE_LIST_GRACE_MS = 3_000;
const PAGE_LIST_GRACE_LISTS = 1;
/** Share of the refill the page reserve takes while main-bucket work is
 * waiting (see `refill`). */
const RESERVE_REFILL_SPLIT = 1 / 3;
/** Adaptive jobs never go below this share of their allowance. */
export const MIN_BACKGROUND_FACTOR = 0.25;
/** A capped consumer may save up this many minutes of its cap. */
const CAP_SAVED_MINUTES = 1;
/** Share of the effective budget the capped consumers may take together. */
export const CAPPED_SHARE = 0.75;
/** Share of the rate a process refills at while it is starting up. */
export const STARTUP_RATE_SHARE = 0.5;
/** Consumer caps are re-read from settings this often. */
const CAPS_TTL_MS = 30_000;

/** Background ranks of trader-page calls; lower goes first. `analytics`: a
 * trade-analytics job a page started (not the page's own request): after
 * every page call, ahead of every periodic job. */
export const PAGE_RANK = { profile: 0, portfolio: 1, fills: 2, analytics: 3 } as const;
/** Background ranks up to this may spend the page reserve. */
export const INTERACTIVE_MAX_RANK = PAGE_RANK.portfolio;
/** Rank of a background call that names none: behind every page rank. */
export const UNRANKED_BASE = 1_000;
/** Default rank of the calls of essential consumers (by label): behind
 * pages, ahead of every other background job. The 5-minute snapshots go
 * first, then the fill confirms of watched leaders, then the sweeps, then
 * the cohort's reads, then the worker's refresh of the watched traders'
 * analytics (`tracked`: unranked, it queued behind the pool and history
 * and timed out, gap audit 2026-10-05). */
export const ESSENTIAL_RANK = { snapshots: 100, confirm: 105, sweep: 110, cohort: 120, tracked: 130 } as const satisfies Record<string, number>;
/** Background ranks up to this are on-demand page work (see above). */
export const PAGE_WORK_MAX_RANK = PAGE_RANK.fills;
/** Whether a call at this lane and rank is on-demand page work. */
export const isPageWork = (priority: RequestPriority, rank: number | undefined): boolean =>
  priority === "background" && rank !== undefined && rank <= PAGE_WORK_MAX_RANK;
/** Share of the budget page work may spend, over `PAGE_SHARE_WINDOW_MS`,
 * while other background work is waiting. */
export const PAGE_SHARE = 0.5;
/** The share is measured over this window, not a single minute, so a few
 * cold pages in a row (≈ 270–360 weight each) go out at once and only a
 * sustained flood is held to the share. */
export const PAGE_SHARE_WINDOW_MS = 3 * 60_000;
/** Seconds of the configured budget page work may have queued at once. */
const PAGE_QUEUE_SECONDS = 30;
/** Share of the page queue one client may hold. */
const PAGE_CLIENT_SHARE = 0.5;
/** A page call that waited this long for its turn is logged … */
const SLOW_PAGE_WAIT_MS = 2_000;
/** … at most once per this long. */
const SLOW_PAGE_LOG_EVERY_MS = 10_000;
/** Waiters other than page work (live and background) that may queue. */
export const MAX_QUEUED = 1000;

/** Consumer labels the budgeter assigns itself. */
export const CONSUMER_PAGE = "page";
/** The label of trade-analytics work a request started (its computation
 * and funding): page-driven work, held to the page share with the pages. */
export const CONSUMER_ANALYTICS = "analytics";
export const CONSUMER_LIVE = "live";
export const CONSUMER_OTHER = "other";

/** Page work refused because the page budget (global or the caller's) is
 * full. Callers answer 503 busy rather than queueing it. */
export class PageBusyError extends Error {
  override readonly name = "PageBusyError";
  constructor(message = "Hyperliquid page budget is full") { super(message); }
}

/** A call gave up waiting for the budget (see `budgetConsumer`'s `queueMs`). */
export class BudgetWaitError extends Error {
  override readonly name = "BudgetWaitError";
  constructor(consumer: string, ms: number) { super(`Hyperliquid budget not available to ${consumer} within ${Math.round(ms / 1000)} s`); }
}

const consumers = new AsyncLocalStorage<{ label: string; queueMs?: number }>();

/** Runs `work` with every Hyperliquid call inside accounted to `label`
 * (and subject to its cap and default rank, if any). `queueMs`: a call
 * inside that waits longer than this for the budget fails. Survives
 * `BackgroundJobs.run`, which leaves the request context but not this one. */
export function budgetConsumer<T>(label: string, work: () => T, options: { queueMs?: number } = {}): T {
  return consumers.run({ label, queueMs: options.queueMs }, work);
}

/** The consumer label of the current async context, if any. */
export const currentBudgetConsumer = () => consumers.getStore()?.label;

interface Waiter {
  /** Taken from the buckets when the call goes out. */
  weight: number;
  /** Tokens (beyond the reserves) the call waits for; see `acquire`. */
  gate: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
  /** Lower goes first within a lane; ties go in arrival order. */
  rank: number;
  seq: number;
  /** On-demand page work (see the class comment). */
  page: boolean;
  /** May spend the page reserve. */
  interactive: boolean;
  consumer: string;
  /** When it joined the queue (epoch ms). */
  queuedAt: number;
}

/** Reads the per-minute caps of labelled consumers (the settings service,
 * injected loosely so the budgeter stays free of the settings module). */
export interface ConsumerCapSource {
  consumerCaps(): Promise<Record<string, number>>;
}

@Injectable()
export class RequestBudgeterService {
  private readonly logger = new Logger(RequestBudgeterService.name);

  /** Trailing-60s log. `request` is false for post-hoc surcharge entries,
   * so `requestsLastMinute` counts calls, not log lines. */
  private readonly window: { ts: number; weight: number; request: boolean; consumer: string }[] = [];

  private readonly configuredBudgetPerMin: number;
  private effectiveBudgetPerMin: number;
  private readonly floorBudgetPerMin: number;
  /** Burst: main capacity + reserve capacity. */
  private readonly capacity: number;
  private readonly mainCapacity: number;
  readonly reserveCapacity: number;
  private readonly liveReserve: number;
  /** Share of the rate the reserve keeps refilling at while page work is
   * over its share of the minute. */
  readonly pageReserveShare: number;

  /** The main bucket (may be negative: debt). */
  private tokens: number;
  /** The page reserve (never negative). */
  private reserve: number;
  private lastRefillAt: number;
  private readonly queues: Record<RequestPriority, Waiter[]> = { live: [], background: [] };
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private stopped = false;
  /** Live dispatches in a row while background waiters existed. */
  private liveStreak = 0;
  /** When a slow page call was last logged. */
  private slowPageLoggedAt = 0;

  /** Page weight dispatched in the trailing `PAGE_SHARE_WINDOW_MS`, and its
   * running sum. */
  private readonly pageWindow: { ts: number; weight: number }[] = [];
  private pageWindowWeight = 0;
  /** Worst-case surcharges of page lists just dispatched (see
   * `PAGE_LIST_GRACE_MS`). */
  private readonly pageListGrace: { ts: number; surplus: number }[] = [];
  /** Page weight waiting, overall and per client. */
  private pageQueued = 0;
  private readonly pageQueuedByClient = new Map<string, number>();
  /** Page weight that may wait at once, overall and per client. */
  readonly pageQueueMax: number;
  readonly pageClientQueueMax: number;

  /** Per-consumer caps (weight per minute) and their token buckets. */
  private caps = new Map<string, number>();
  private readonly capTokens = new Map<string, { tokens: number; at: number }>();
  private capsSource: ConsumerCapSource | undefined;
  private capsReadAt = 0;
  private capsReading: Promise<void> | undefined;

  private consecutiveSuccesses = 0;
  private lastRateLimitedAt: number | undefined;
  /** Until this time the refill runs at `STARTUP_RATE_SHARE` (0: not paced). */
  private readonly startupUntil: number;

  constructor(private readonly config: AppConfig) {
    const hl = this.config.value.hyperliquid;
    this.configuredBudgetPerMin = hl.budgetPerMin;
    this.effectiveBudgetPerMin = this.configuredBudgetPerMin;
    this.floorBudgetPerMin = Math.max(1, Math.round(this.configuredBudgetPerMin * 0.2));
    this.capacity = Math.max(1, Math.min(hl.burst, HARD_LIMIT_PER_MIN - this.configuredBudgetPerMin));
    // The main bucket keeps at least one token of burst, so a tiny burst
    // (tests) still paces instead of dispatching into endless debt.
    this.mainCapacity = Math.max(1, this.capacity - Math.round(this.capacity * PAGE_RESERVE_CAPACITY_SHARE));
    this.reserveCapacity = this.capacity - this.mainCapacity;
    this.liveReserve = Math.floor(this.mainCapacity * LIVE_RESERVE_SHARE);
    this.pageReserveShare = hl.pageReserveShare;
    this.lastRefillAt = Date.now();
    const paced = hl.startupPaceSeconds > 0;
    this.startupUntil = paced ? this.lastRefillAt + hl.startupPaceSeconds * 1000 : 0;
    // A paced start has no burst to spend: the instance being replaced may
    // just have spent its own.
    this.tokens = paced ? 0 : this.mainCapacity;
    this.reserve = paced ? 0 : this.reserveCapacity;
    if (paced) this.logger.log(`Starting at ${STARTUP_RATE_SHARE * 100}% of ${this.configuredBudgetPerMin}/min with empty buckets for ${hl.startupPaceSeconds} s`);
    this.pageQueueMax = Math.round((this.configuredBudgetPerMin * PAGE_QUEUE_SECONDS) / 60) + this.capacity;
    this.pageClientQueueMax = Math.round(this.pageQueueMax * PAGE_CLIENT_SHARE);
  }

  /** Tokens per millisecond at the current rate (reduced during start-up). */
  private rate(now = Date.now()): number {
    return (this.effectiveBudgetPerMin / 60_000) * (now < this.startupUntil ? STARTUP_RATE_SHARE : 1);
  }

  /** Tokens refilled between two times: the part before the start-up
   * period ends at the reduced rate, the rest at the full one. */
  private refilled(from: number, to: number): number {
    const full = this.effectiveBudgetPerMin / 60_000;
    const paced = Math.max(0, Math.min(to, this.startupUntil) - from);
    return paced * full * STARTUP_RATE_SHARE + (to - from - paced) * full;
  }

  /**
   * Refills both buckets from one rate. The reserve gets everything until
   * it is full while nothing waits for the main bucket or a first-paint
   * call waits for it; a third of the refill while only main-bucket work is
   * waiting (so a cold page's own fill lists aren't held behind the
   * reserve refilling after its first paint); and only its guaranteed
   * share (`pageReserveShare`) while page work is over its share of the
   * minute. The rest goes to the main bucket.
   */
  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.lastRefillAt);
    this.lastRefillAt = now;
    if (elapsed === 0) return;
    const delta = this.refilled(now - elapsed, now);
    // While a first-paint call waits for the reserve, the whole refill is
    // its: split with the fill lists and trade-analytics jobs that are
    // always queued behind a cold page, a second cold page's profile waited
    // three times as long as the budget needed (Stage, 2026-10-05).
    const background = this.queues.background;
    const share = this.pageHeld(now) ? this.pageReserveShare
      : background.some((w) => w.interactive) || !background.some((w) => !w.interactive) ? 1 : RESERVE_REFILL_SPLIT;
    const toReserve = Math.min(delta * share, Math.max(0, this.reserveCapacity - this.reserve));
    this.reserve += toReserve;
    this.tokens = Math.min(this.mainCapacity, this.tokens + delta - toReserve);
    const scale = this.capScale();
    for (const [label, configured] of this.caps) {
      const cap = configured * scale;
      const bucket = this.capTokens.get(label) ?? { tokens: cap * CAP_SAVED_MINUTES, at: now };
      bucket.tokens = Math.min(cap * CAP_SAVED_MINUTES, bucket.tokens + ((now - bucket.at) / 60_000) * cap);
      bucket.at = now;
      this.capTokens.set(label, bucket);
    }
  }

  /** Milliseconds until `tokens` more have been refilled. */
  private msToRefill(tokens: number, now: number): number {
    const full = this.effectiveBudgetPerMin / 60_000;
    const paced = Math.max(0, this.startupUntil - now);
    const duringStartup = paced * full * STARTUP_RATE_SHARE;
    return Math.ceil(tokens <= duringStartup ? tokens / (full * STARTUP_RATE_SHARE) : paced + (tokens - duringStartup) / full);
  }

  private prune(now: number): void {
    const cutoff = now - 60_000;
    while (this.window.length > 0 && this.window[0].ts < cutoff) {
      this.window.shift();
    }
    const pageCutoff = now - PAGE_SHARE_WINDOW_MS;
    while (this.pageWindow.length > 0 && this.pageWindow[0].ts < pageCutoff) {
      this.pageWindowWeight -= this.pageWindow.shift()!.weight;
    }
  }

  /** Work a page view caused: its own calls, and the trade-analytics jobs
   * it started (`CONSUMER_ANALYTICS`: a request's computation and funding). */
  private pageDriven(waiter: Waiter): boolean {
    return waiter.page || waiter.consumer === CONSUMER_ANALYTICS;
  }

  /**
   * Page work is held to its share now: it has used its share of the
   * budget over `PAGE_SHARE_WINDOW_MS` *and* other background work (fill
   * storage, snapshots, sweeps, the pool) is waiting. With nothing else
   * waiting it may use everything, as the class comment says: an api
   * process runs no periodic jobs, so the only background work it held
   * first paint for was the trade analytics its own pages had started,
   * and a visitor browsing a few cold Top 100 traders a minute got first
   * paint at the reserve's 25% refill (Stage, 2026-10-05: 10–30 s).
   */
  private pageHeld(now: number): boolean {
    return this.pageOverShare(now) && this.queues.background.some((w) => !this.pageDriven(w));
  }

  /** Page work has used its share of the budget over `PAGE_SHARE_WINDOW_MS`. */
  private pageOverShare(now: number): boolean {
    this.prune(now);
    return Math.max(0, this.pageWindowWeight) >= (PAGE_SHARE * this.effectiveBudgetPerMin * PAGE_SHARE_WINDOW_MS) / 60_000;
  }

  private record(ts: number, weight: number, request = true, consumer = this.consumerOf()): void {
    this.window.push({ ts, weight, request, consumer });
    this.prune(Date.now());
  }

  private consumerOf(priority: RequestPriority = "background", page = false): string {
    return consumers.getStore()?.label ?? (priority === "live" ? CONSUMER_LIVE : page ? CONSUMER_PAGE : CONSUMER_OTHER);
  }

  // --- consumer caps --------------------------------------------------------

  /** Weight-per-minute caps per consumer label; a label absent is uncapped. */
  setConsumerCaps(caps: Record<string, number>): void {
    const next = new Map(Object.entries(caps).filter(([, v]) => Number.isFinite(v) && v >= 0));
    for (const label of this.capTokens.keys()) if (!next.has(label)) this.capTokens.delete(label);
    this.caps = next;
    this.rearm();
  }

  /** Where the caps come from (the settings module registers itself). */
  useConsumerCaps(source: ConsumerCapSource): void {
    this.capsSource = source;
    this.capsReadAt = 0;
  }

  /** Re-reads the caps when they are stale; never blocks a caller. */
  private refreshCaps(now: number): void {
    if (!this.capsSource || this.capsReading || now - this.capsReadAt < CAPS_TTL_MS) return;
    this.capsReadAt = now;
    this.capsReading = this.capsSource.consumerCaps()
      .then((caps) => this.setConsumerCaps(caps))
      .catch((error: Error) => this.logger.warn(`Consumer caps unavailable: ${error.message}`))
      .finally(() => { this.capsReading = undefined; });
  }

  /** What the configured caps are multiplied by so that together they stay
   * within `CAPPED_SHARE` of the effective budget (1: they fit). */
  private capScale(): number {
    let total = 0;
    for (const cap of this.caps.values()) total += cap;
    const room = CAPPED_SHARE * this.effectiveBudgetPerMin;
    return total > room ? room / total : 1;
  }

  /** The cap a label is held to now (weight per minute); undefined: none. */
  consumerCap(label: string): number | undefined {
    const configured = this.caps.get(label);
    return configured === undefined ? undefined : configured * this.capScale();
  }

  /** Milliseconds until a capped consumer may send `weight`; 0 when it may
   * now. A call heavier than the bucket waits for a full bucket. */
  private capWait(label: string, weight: number): number {
    const cap = this.consumerCap(label);
    if (cap === undefined) return 0;
    if (cap <= 0) return Infinity;
    const capacity = cap * CAP_SAVED_MINUTES;
    const tokens = this.capTokens.get(label)?.tokens ?? capacity;
    const short = Math.min(weight, capacity) - tokens;
    // A hair under a full bucket (float refill) is full.
    return short <= 1e-6 ? 0 : Math.ceil(short / (cap / 60_000));
  }

  private chargeCap(label: string, weight: number): void {
    const cap = this.consumerCap(label);
    if (cap === undefined) return;
    const bucket = this.capTokens.get(label) ?? { tokens: cap * CAP_SAVED_MINUTES, at: Date.now() };
    bucket.tokens -= weight;
    this.capTokens.set(label, bucket);
  }

  // --- adaptive hints for jobs ----------------------------------------------

  /** Page weight dispatched in the trailing minute. */
  pageWeightLastMinute(): number {
    const now = Date.now();
    this.prune(now);
    let weight = 0;
    for (let i = this.pageWindow.length - 1; i >= 0 && this.pageWindow[i].ts >= now - 60_000; i--) weight += this.pageWindow[i].weight;
    return Math.max(0, weight);
  }

  /**
   * How much of its allowance an adaptive background job should use now:
   * 1 while page work in the trailing minute is within the reserve's share
   * of the budget, down to `MIN_BACKGROUND_FACTOR` as page work reaches
   * `PAGE_SHARE` of it.
   */
  backgroundFactor(): number {
    const budget = this.effectiveBudgetPerMin;
    const low = this.pageReserveShare * budget;
    const high = PAGE_SHARE * budget;
    const used = this.pageWeightLastMinute();
    if (used <= low || high <= low) return 1;
    const t = Math.min(1, (used - low) / (high - low));
    return 1 - t * (1 - MIN_BACKGROUND_FACTOR);
  }

  /** Interactive page calls are waiting, or the reserve is not full: a
   * heavy background step started now would compete with a page. */
  pagePressure(): boolean {
    this.refill(Date.now());
    return this.reserve < this.reserveCapacity || this.queues.background.some((w) => w.interactive);
  }

  /**
   * Resolves once it is this call's turn to go out. `live` waiters are
   * released before `background` ones (but see the starvation guard).
   * Within a lane the lowest `rank` goes first (default: arrival order).
   * The watcher ranks live calls by when that address was last served, so
   * an address that trades once an hour isn't stuck behind bots that trade
   * every second.
   */
  acquire(
    weight: number,
    priority: RequestPriority = "background",
    rank?: number,
    { known = weight, signal }: { known?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Budgeter stopped"));
    this.refreshCaps(Date.now());
    const page = priority === "background" && rank !== undefined && rank <= PAGE_WORK_MAX_RANK;
    const interactive = priority === "background" && rank !== undefined && rank <= INTERACTIVE_MAX_RANK;
    // Page work made for an HTTP request stops waiting once it is answered.
    const answered = page ? currentRequestAnswered() : undefined;
    const cancel = signal && answered && signal !== answered ? AbortSignal.any([signal, answered]) : (signal ?? answered);
    if (cancel?.aborted) return Promise.reject(cancel.reason);
    const client = page ? currentRequestClient() : undefined;
    // Page work is counted by its known cost (a list call's base).
    const held = Math.min(known, weight);
    if (page) {
      const mine = client === undefined ? 0 : (this.pageQueuedByClient.get(client) ?? 0);
      // An empty queue always takes one call, however heavy.
      if (this.pageQueued > 0 && this.pageQueued + held > this.pageQueueMax) return Promise.reject(new PageBusyError());
      if (mine > 0 && mine + held > this.pageClientQueueMax) return Promise.reject(new PageBusyError("Hyperliquid page budget for this client is full"));
    } else if (this.queues.live.length + this.queues.background.length - this.pageWaiters() >= MAX_QUEUED) {
      return Promise.reject(new Error("Hyperliquid queue is full"));
    }
    const consumer = this.consumerOf(priority, page);
    const queueMs = consumers.getStore()?.queueMs;
    return new Promise((resolve, reject) => {
      const seq = this.seq++;
      const queue = this.queues[priority];
      const defaultRank = priority === "background" ? ((ESSENTIAL_RANK as Readonly<Record<string, number>>)[consumer] ?? UNRANKED_BASE + seq) : seq;
      const r = rank ?? defaultRank;
      // A page's list call, and a trade-analytics job's, waits only for its
      // known part (the surplus is given back once the answer is counted);
      // everything else waits for its whole (worst-case) weight. Gated on
      // the worst case, a cold trader's 14 history reads took 90 s.
      const gate = priority === "background" && r <= PAGE_RANK.analytics ? Math.min(known, weight) : weight;
      const leave = (reason: unknown) => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        waiter.cleanup();
        reject(reason);
        this.rearm();
      };
      const abort = () => leave(cancel?.reason ?? new Error("Request cancelled"));
      // A periodic job's call does not wait past its consumer's deadline.
      const deadline = queueMs === undefined ? undefined : setTimeout(() => leave(new BudgetWaitError(consumer, queueMs)), queueMs);
      let holding = page;
      if (page) this.holdPage(client, held);
      const waiter: Waiter = { weight, gate, resolve, reject, rank: r, seq, page, interactive, consumer, queuedAt: Date.now(),
        cleanup: () => {
          clearTimeout(deadline);
          cancel?.removeEventListener("abort", abort);
          if (holding) { holding = false; this.holdPage(client, -held); }
        } };
      cancel?.addEventListener("abort", abort, { once: true });
      queue.push(waiter);
      // A newcomer may go before the waiter the pending timer is for.
      this.rearm();
    });
  }

  onModuleDestroy(): void {
    this.stopped = true;
    clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    for (const queue of Object.values(this.queues)) {
      for (const waiter of queue.splice(0)) { waiter.cleanup(); waiter.reject(new Error("Budgeter stopped")); }
    }
  }

  private pageWaiters(): number {
    let n = 0;
    for (const waiter of this.queues.background) if (waiter.page) n++;
    return n;
  }

  private holdPage(client: string | undefined, weight: number): void {
    this.pageQueued += weight;
    if (client === undefined) return;
    const next = (this.pageQueuedByClient.get(client) ?? 0) + weight;
    if (next > 0) this.pageQueuedByClient.set(client, next);
    else this.pageQueuedByClient.delete(client);
  }

  /** Page weight waiting, overall and for one client (tests, health). */
  pageQueuedWeight(client?: string): number {
    return client === undefined ? this.pageQueued : (this.pageQueuedByClient.get(client) ?? 0);
  }

  /**
   * About how long a `live` call of `weight` queued now would wait: the
   * live waiters ahead of it plus its own weight, less what the buckets
   * hold, at the current refill rate (0: it would go now). A hint for a
   * caller deciding whether to wait or come back later, not a promise:
   * background turns and 429 backoffs can make it longer.
   */
  liveWaitMs(weight: number): number {
    const now = Date.now();
    this.refill(now);
    const ahead = this.queues.live.reduce((sum, waiter) => sum + waiter.gate, 0);
    const short = Math.min(weight, this.mainCapacity + this.reserveCapacity) + ahead - (this.tokens + this.reserve);
    return short <= 0 ? 0 : this.msToRefill(short, now);
  }

  /** Waiters currently queued per lane (introspection and tests). */
  queued(): Record<RequestPriority, number> {
    return { live: this.queues.live.length, background: this.queues.background.length };
  }

  private rearm(): void {
    clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    this.pump();
  }

  private nextLane(): { lane: RequestPriority; forced: boolean } | null {
    const { live, background } = this.queues;
    if (live.length === 0) return background.length > 0 ? { lane: "background", forced: false } : null;
    if (background.length > 0 && this.liveStreak >= MAX_LIVE_STREAK) return { lane: "background", forced: true };
    return { lane: "live", forced: false };
  }

  /**
   * What `next` may spend now, and the most it could ever spend (a call
   * heavier than that waits for all of it and takes the main bucket into
   * debt). Live: the reserve plus the main bucket above its debt.
   * Interactive page calls: the reserve plus,
   * unless page work is over its share, the main bucket above live's
   * reserve. Other background: the main bucket above live's reserve
   * (all of it on a forced turn).
   */
  private allowance(next: Waiter, lane: RequestPriority, forced: boolean, now: number): { available: number; most: number } {
    // Live counts the reserve and the main bucket above its debt.
    if (lane === "live") return { available: Math.max(0, this.tokens) + this.reserve, most: this.mainCapacity + this.reserveCapacity };
    if (next.interactive) {
      const main = this.pageHeld(now) ? 0 : Math.max(0, this.tokens - this.liveReserve);
      return { available: this.reserve + main, most: this.reserveCapacity + this.mainCapacity - this.liveReserve };
    }
    const reserve = forced ? 0 : this.liveReserve;
    const grace = next.page ? this.pageListGraceDebt(now) : 0;
    return { available: this.tokens - reserve + grace, most: this.mainCapacity - reserve };
  }

  /** Worst-case surcharge of the newest page lists still in their grace. */
  private pageListGraceDebt(now: number): number {
    while (this.pageListGrace.length > 0 && now - this.pageListGrace[0].ts > PAGE_LIST_GRACE_MS) this.pageListGrace.shift();
    let debt = 0;
    for (const entry of this.pageListGrace.slice(-PAGE_LIST_GRACE_LISTS)) debt += entry.surplus;
    return debt;
  }

  /** Tokens `next` is short of going now (≤ 0: it may go). */
  private shortfall(next: Waiter, lane: RequestPriority, forced: boolean, now: number): number {
    const { available, most } = this.allowance(next, lane, forced, now);
    return Math.min(next.gate, most) - available;
  }

  /** Takes `weight` for `next`: live and interactive calls from the
   * reserve then the main bucket (so live never eats what a waiting
   * background call is saving up for); others from the main bucket (into
   * debt if need be). */
  private spend(next: Waiter, lane: RequestPriority): void {
    let weight = next.weight;
    if (lane === "live" || next.interactive) {
      const fromReserve = Math.min(weight, this.reserve);
      this.reserve -= fromReserve;
      weight -= fromReserve;
    }
    this.tokens -= weight;
  }

  private pump(): void {
    if (this.pumpTimer) return;
    for (;;) {
      const pick = this.nextLane();
      if (!pick) return;
      const lane = this.queues[pick.lane];
      const now = Date.now();
      this.refill(now);
      // Page work over its share of the minute (and the analytics its pages
      // started) yields to any other background waiter (fill storage,
      // snapshots, sweeps); interactive calls are served from the reserve
      // regardless.
      const overShare = pick.lane === "background" && this.pageHeld(now);
      const skipPage = overShare;
      // The best waiter of each bucket: interactive calls (the reserve) and
      // everything else (the main bucket). Within a bucket the lowest rank
      // goes first even when a later one would fit now, so tokens build up
      // for a heavy call instead of a stream of small ones starving it.
      let interactive = -1;
      let other = -1;
      let capped = Infinity;
      for (let i = 0; i < lane.length; i++) {
        const a = lane[i];
        if (skipPage && this.pageDriven(a) && !a.interactive) continue;
        // A page-rank call is charged to its consumer but never held by its cap.
        const wait = a.page ? 0 : this.capWait(a.consumer, a.weight);
        if (wait > 0) { capped = Math.min(capped, wait); continue; }
        const slot = pick.lane === "background" && a.interactive ? interactive : other;
        const b = lane[slot];
        if (slot < 0 || a.rank < b.rank || (a.rank === b.rank && a.seq < b.seq)) {
          if (pick.lane === "background" && a.interactive) interactive = i;
          else other = i;
        }
      }
      if (interactive < 0 && other < 0) {
        // A forced background turn with nothing able to go (every waiter
        // over its consumer cap) is spent: live must not wait for a cap.
        if (pick.forced) {
          this.liveStreak = 0;
          continue;
        }
        // Everything eligible is capped (or skipped): wake when a cap refills.
        this.sleep(Number.isFinite(capped) ? capped : 1000);
        return;
      }
      // An interactive call goes first. While page work is over its share
      // it lives on the reserve alone, so a main-bucket waiter is not held
      // behind it; otherwise it may draw on the main bucket too and the
      // tokens build up for it.
      let index = interactive >= 0 ? interactive : other;
      let short = this.shortfall(lane[index], pick.lane, pick.forced, now);
      // A forced background turn that can't go yet doesn't hold live while
      // the reserve alone covers it: live goes on, the main bucket keeps
      // filling for the background call, and the streak stays so it is
      // next the moment it can.
      if (short > 0 && pick.forced && this.queues.live.length > 0) {
        const liveIndex = this.queues.live.reduce((best, w, i, q) => (best < 0 || w.rank < q[best].rank || (w.rank === q[best].rank && w.seq < q[best].seq) ? i : best), -1);
        if (this.queues.live[liveIndex].gate <= this.reserve) {
          const next = this.queues.live.splice(liveIndex, 1)[0];
          this.dispatch(next, "live", now);
          continue;
        }
      }
      if (short > 0 && index === interactive && other >= 0 && overShare) {
        const altShort = this.shortfall(lane[other], pick.lane, pick.forced, now);
        if (altShort <= 0) {
          index = other;
          short = altShort;
        } else {
          this.sleep(this.msToRefill(Math.min(short, altShort), now));
          return;
        }
      }
      if (short > 0) {
        this.sleep(this.msToRefill(short, now));
        return;
      }
      const next = lane[index];
      lane.splice(index, 1);
      this.dispatch(next, pick.lane, now);
    }
  }

  private dispatch(next: Waiter, lane: RequestPriority, now: number): void {
    // A page call that waited long is what a slow trader page is made of:
    // say what held it (one line per 10 s at most).
    const waited = now - next.queuedAt;
    if (next.page && waited >= SLOW_PAGE_WAIT_MS && now - this.slowPageLoggedAt >= SLOW_PAGE_LOG_EVERY_MS) {
      this.slowPageLoggedAt = now;
      this.logger.warn(`Page call waited ${waited} ms (rank ${next.rank}, weight ${next.weight}): main ${Math.round(this.tokens)}, reserve ${Math.round(this.reserve)}, ` +
        `page share ${Math.round(Math.max(0, this.pageWindowWeight))}/${Math.round((PAGE_SHARE * this.effectiveBudgetPerMin * PAGE_SHARE_WINDOW_MS) / 60_000)}, ` +
        `queued ${this.queues.live.length} live + ${this.queues.background.length} background (${this.pageWaiters()} page)`);
    }
    this.spend(next, lane);
    this.chargeCap(next.consumer, next.weight);
    this.liveStreak = lane === "live" && this.queues.background.length > 0 ? this.liveStreak + 1 : 0;
    this.record(now, next.weight, true, next.consumer);
    if (next.page) {
      this.pageWindow.push({ ts: now, weight: next.weight });
      this.pageWindowWeight += next.weight;
      if (next.weight > next.gate) this.pageListGrace.push({ ts: now, surplus: next.weight - next.gate });
    }
    next.cleanup();
    next.resolve();
  }

  private sleep(ms: number): void {
    this.pumpTimer = setTimeout(
      () => {
        this.pumpTimer = undefined;
        this.pump();
      },
      Math.max(1, Math.min(ms, 60_000)),
    );
  }

  /**
   * Reports weight consumed that couldn't be known until after the
   * response arrived (userFillsByTime's per-20-items surcharge). Taken from
   * the main bucket for future callers; never delays the caller that just
   * finished — the call already happened.
   */
  recordAdditionalWeight(weight: number): void {
    if (weight <= 0) return;
    const now = Date.now();
    this.refill(now);
    this.tokens -= weight;
    this.chargeCap(this.consumerOf(), weight);
    this.record(now, weight, false);
  }

  /**
   * Settles a call acquired with a worst-case estimate: a positive `delta`
   * is charged like `recordAdditionalWeight`, a negative one (the estimate
   * was too high) goes back to the main bucket, and waiters may go at once.
   * `page`: the call was page work (`isPageWork`), so its page share is
   * settled too.
   */
  adjust(delta: number, { page = false }: { page?: boolean } = {}): void {
    // A page list's settled cost is what page work spent: its worst case
    // (120) counted in full against `PAGE_SHARE` put page work "over its
    // share" after three cold pages' fill lists (6 × 120 = 720, the 3-minute
    // share at 480/min) even though they had cost ~280, and first paint then
    // lived on the reserve's 25% refill for minutes (Stage, 2026-10-05).
    if (page && delta !== 0) {
      this.pageWindow.push({ ts: Date.now(), weight: delta });
      this.pageWindowWeight += delta;
    }
    if (delta >= 0) {
      this.recordAdditionalWeight(delta);
      return;
    }
    const now = Date.now();
    this.refill(now);
    this.tokens = Math.min(this.mainCapacity, this.tokens - delta);
    this.chargeCap(this.consumerOf(), delta);
    this.record(now, delta, false);
    this.rearm();
  }

  /** Call after a successful (non-429) response, for gradual recovery. */
  onSuccess(): void {
    this.consecutiveSuccesses += 1;
    if (
      this.consecutiveSuccesses >= 20 &&
      this.effectiveBudgetPerMin < this.configuredBudgetPerMin
    ) {
      this.refill(Date.now());
      this.effectiveBudgetPerMin = Math.min(
        this.configuredBudgetPerMin,
        this.effectiveBudgetPerMin + this.configuredBudgetPerMin * 0.1,
      );
      this.consecutiveSuccesses = 0;
      this.logger.log(
        `Recovering budget after sustained success: effective=${this.effectiveBudgetPerMin.toFixed(0)}/min (cap=${this.configuredBudgetPerMin})`,
      );
    }
  }

  /** Call on an actual HTTP 429 from Hyperliquid — backs off immediately. */
  onRateLimited(): void {
    this.consecutiveSuccesses = 0;
    this.lastRateLimitedAt = Date.now();
    this.refill(Date.now());
    const next = Math.max(
      this.floorBudgetPerMin,
      Math.round(this.effectiveBudgetPerMin * 0.5),
    );
    this.logger.warn(
      `429 from Hyperliquid — backing off effective budget ${this.effectiveBudgetPerMin.toFixed(0)} -> ${next}/min`,
    );
    this.effectiveBudgetPerMin = next;
    // Also empty both buckets, the main one 2 s into debt, so we don't
    // immediately retry into another 429 while the lower rate takes effect.
    this.reserve = 0;
    this.tokens = Math.min(this.tokens, 0) - 2000 * this.rate();
    if (this.pumpTimer) this.rearm();
  }

  /** Introspection for the /health heartbeat (§8 可觀測). */
  introspect(): {
    requestsLastMinute: number;
    weightLastMinute: number;
    effectiveBudgetPerMin: number;
    configuredBudgetPerMin: number;
    burstCapacity: number;
    /** Main bucket + page reserve. */
    tokensAvailable: number;
    /** The page reserve's tokens and capacity. */
    reserveTokens: number;
    reserveCapacity: number;
    /** Page weight in the trailing minute and the adaptive factor jobs see. */
    pageWeightLastMinute: number;
    backgroundFactor: number;
    /** Weight in the trailing minute per consumer label. */
    consumers: Record<string, number>;
    /** The cap each capped consumer is held to now (scaled to the effective budget). */
    consumerCaps: Record<string, number>;
    lastRateLimitedAt: Date | null;
  } {
    const now = Date.now();
    this.prune(now);
    this.refill(now);
    const byConsumer: Record<string, number> = {};
    for (const e of this.window) byConsumer[e.consumer] = (byConsumer[e.consumer] ?? 0) + e.weight;
    return {
      requestsLastMinute: this.window.filter((e) => e.request).length,
      weightLastMinute: this.window.reduce((sum, e) => sum + e.weight, 0),
      effectiveBudgetPerMin: this.effectiveBudgetPerMin,
      configuredBudgetPerMin: this.configuredBudgetPerMin,
      burstCapacity: this.capacity,
      tokensAvailable: this.tokens + this.reserve,
      reserveTokens: this.reserve,
      reserveCapacity: this.reserveCapacity,
      pageWeightLastMinute: this.pageWeightLastMinute(),
      backgroundFactor: this.backgroundFactor(),
      consumers: byConsumer,
      consumerCaps: Object.fromEntries([...this.caps.keys()].map((label) => [label, Math.round(this.consumerCap(label)!)])),
      lastRateLimitedAt: this.lastRateLimitedAt
        ? new Date(this.lastRateLimitedAt)
        : null,
    };
  }
}
