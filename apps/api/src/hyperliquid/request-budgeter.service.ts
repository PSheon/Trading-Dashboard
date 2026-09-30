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
 * sweep, (e) A5 backfill and (f) page loads. Only (a) is latency-sensitive,
 * so it runs in the `live` lane; everything else is `background`. The
 * default rate is PRD §8's 70% of 1200.
 *
 * ## Design
 *
 * A token bucket with two priority lanes. Tokens (weight) refill at the
 * budget rate up to `HYPERLIQUID_WEIGHT_BURST` (default 200), so a few
 * calls after a quiet spell go out at once (a cold page load) while the
 * long-run average stays at the budget. Any 60 s then carries at most
 * rate + burst; the burst is capped so that stays under Hyperliquid's 1200.
 *
 * - `live` waiters go before `background` ones, and `background` may not
 *   spend the last 10% of the bucket, which stays for `live`: a burst of
 *   page loads leaves a detection call its tokens.
 * - Starvation guard: while `background` waiters exist, at least one in
 *   every four dispatches goes to `background`.
 * - Within a lane the lowest `rank` goes first.
 * - A call heavier than the bucket waits for a full bucket and takes it
 *   negative, so it always runs eventually and later callers pay for it.
 *
 * ## Page loads (Stage 2 §10 cold trader pages)
 *
 * Trader-page calls are `background` with ranks 0–3 (`PAGE_RANK`): the
 * profile (first paint) 0, portfolio 1, fills/activity 2, home warm-up 3.
 * Every other background call without an explicit rank gets
 * `UNRANKED_BASE + arrival`, so it always sorts behind them.
 *
 * - Background calls ranked above `INTERACTIVE_MAX_RANK` (anything but the
 *   profile and portfolio) also leave `INTERACTIVE_RESERVE_SHARE` of the
 *   bucket, so a first paint finds tokens even while backfill, sweeps and
 *   heavy fill lists are queued.
 * - The lowest-ranked waiter is served first even when a later one would
 *   fit now, so a heavy page call isn't starved by a stream of small
 *   background calls: the tokens build up for it.
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
 *   alerts, snapshots, sweeps) goes first. Below the share page work keeps
 *   its priority, and with nothing else waiting it may use everything.
 * - A page waiter made inside an HTTP request is dropped once that request
 *   has been answered or abandoned (`currentRequestAnswered`).
 *
 * On a real 429 the rate halves (floor 20% of the budget) and the bucket
 * goes 2 s into debt; the rate recovers by 10% of the budget per 20
 * consecutive successes. List endpoints (`userFills`, `userFillsByTime`,
 * TWAP slices) cost 1 more per 20 items returned, known only afterwards:
 * the client acquires the worst case up front and `adjust()`s the bucket by
 * the difference once the response is in. Charging afterwards instead let
 * a burst of heavy lists (each up to +100) drive the bucket hundreds into
 * debt, and every call queued behind them, a first paint included, paid it.
 * Background lists wait for their whole worst case; a page's list (rank ≤
 * `PAGE_RANK.fills`) waits only for its known base plus the reserves, then
 * takes the worst case, so at most one such list at a time runs the bucket
 * below zero (by ≤ 100), and first paints, first in line, pay a few
 * seconds at most instead of waiting behind every list.
 */
export type RequestPriority = "live" | "background";

/** Hyperliquid's documented REST limit per IP. */
const HARD_LIMIT_PER_MIN = 1200;
/** Share of the bucket only `live` may spend. */
const LIVE_RESERVE_SHARE = 0.1;
/** Further share that only live and interactive page loads may spend. */
const INTERACTIVE_RESERVE_SHARE = 0.2;
/** Live dispatches in a row, while background waits, before one background. */
const MAX_LIVE_STREAK = 3;

/** Background ranks of trader-page and home-page calls; lower goes first. */
export const PAGE_RANK = { profile: 0, portfolio: 1, fills: 2, warm: 3 } as const;
/** Background ranks up to this may spend the interactive reserve. */
export const INTERACTIVE_MAX_RANK = PAGE_RANK.portfolio;
/** Rank of a background call that names none: behind every page rank. */
export const UNRANKED_BASE = 1_000;
/** Background ranks up to this are on-demand page work (see above). */
export const PAGE_WORK_MAX_RANK = PAGE_RANK.fills;
/** Share of the budget page work may spend per minute while other
 * background work is waiting. */
export const PAGE_SHARE = 0.5;
/** Seconds of the configured budget page work may have queued at once. */
const PAGE_QUEUE_SECONDS = 30;
/** Share of the page queue one client may hold. */
const PAGE_CLIENT_SHARE = 0.5;
/** Waiters other than page work (live and background) that may queue. */
export const MAX_QUEUED = 1000;

/** Page work refused because the page budget (global or the caller's) is
 * full. Callers answer 503 busy rather than queueing it. */
export class PageBusyError extends Error {
  override readonly name = "PageBusyError";
  constructor(message = "Hyperliquid page budget is full") { super(message); }
}

interface Waiter {
  /** Taken from the bucket when the call goes out. */
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
}

@Injectable()
export class RequestBudgeterService {
  private readonly logger = new Logger(RequestBudgeterService.name);

  /** Trailing-60s log. `request` is false for post-hoc surcharge entries,
   * so `requestsLastMinute` counts calls, not log lines. */
  private readonly window: { ts: number; weight: number; request: boolean }[] = [];

  private readonly configuredBudgetPerMin: number;
  private effectiveBudgetPerMin: number;
  private readonly floorBudgetPerMin: number;
  private readonly capacity: number;
  private readonly liveReserve: number;
  private readonly interactiveReserve: number;

  private tokens: number;
  private lastRefillAt: number;
  private readonly queues: Record<RequestPriority, Waiter[]> = { live: [], background: [] };
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private stopped = false;
  /** Live dispatches in a row while background waiters existed. */
  private liveStreak = 0;

  /** Page weight dispatched in the trailing minute, and its running sum. */
  private readonly pageWindow: { ts: number; weight: number }[] = [];
  private pageWindowWeight = 0;
  /** Page weight waiting, overall and per client. */
  private pageQueued = 0;
  private readonly pageQueuedByClient = new Map<string, number>();
  /** Page weight that may wait at once, overall and per client. */
  readonly pageQueueMax: number;
  readonly pageClientQueueMax: number;

  private consecutiveSuccesses = 0;
  private lastRateLimitedAt: number | undefined;

  constructor(private readonly config: AppConfig) {
    this.configuredBudgetPerMin = this.config.value.hyperliquid.budgetPerMin;
    this.effectiveBudgetPerMin = this.configuredBudgetPerMin;
    this.floorBudgetPerMin = Math.max(1, Math.round(this.configuredBudgetPerMin * 0.2));
    const burst = this.config.value.hyperliquid.burst;
    this.capacity = Math.max(1, Math.min(burst, HARD_LIMIT_PER_MIN - this.configuredBudgetPerMin));
    this.liveReserve = Math.floor(this.capacity * LIVE_RESERVE_SHARE);
    this.interactiveReserve = Math.floor(this.capacity * INTERACTIVE_RESERVE_SHARE);
    this.tokens = this.capacity;
    this.lastRefillAt = Date.now();
    this.pageQueueMax = Math.round((this.configuredBudgetPerMin * PAGE_QUEUE_SECONDS) / 60) + this.capacity;
    this.pageClientQueueMax = Math.round(this.pageQueueMax * PAGE_CLIENT_SHARE);
  }

  /** Tokens per millisecond at the current rate. */
  private rate(): number {
    return this.effectiveBudgetPerMin / 60_000;
  }

  private refill(now: number): void {
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefillAt) * this.rate());
    this.lastRefillAt = now;
  }

  private prune(now: number): void {
    const cutoff = now - 60_000;
    while (this.window.length > 0 && this.window[0].ts < cutoff) {
      this.window.shift();
    }
    while (this.pageWindow.length > 0 && this.pageWindow[0].ts < cutoff) {
      this.pageWindowWeight -= this.pageWindow.shift()!.weight;
    }
  }

  /** Page work has used its share of the trailing minute. */
  private pageOverShare(now: number): boolean {
    this.prune(now);
    return this.pageWindowWeight >= PAGE_SHARE * this.effectiveBudgetPerMin;
  }

  private record(ts: number, weight: number, request = true): void {
    this.window.push({ ts, weight, request });
    this.prune(Date.now());
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
    const page = priority === "background" && rank !== undefined && rank <= PAGE_WORK_MAX_RANK;
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
    return new Promise((resolve, reject) => {
      const seq = this.seq++;
      const queue = this.queues[priority];
      const defaultRank = priority === "background" ? UNRANKED_BASE + seq : seq;
      const r = rank ?? defaultRank;
      // A page's list call waits only for its known part; everything else
      // waits for its whole (worst-case) weight.
      const gate = priority === "background" && r <= PAGE_RANK.fills ? Math.min(known, weight) : weight;
      const abort = () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        waiter.cleanup();
        reject(cancel?.reason ?? new Error("Request cancelled"));
        this.rearm();
      };
      let holding = page;
      if (page) this.holdPage(client, held);
      const waiter: Waiter = { weight, gate, resolve, reject, rank: r, seq, page,
        cleanup: () => {
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

  private pump(): void {
    if (this.pumpTimer) return;
    for (;;) {
      const pick = this.nextLane();
      if (!pick) return;
      const lane = this.queues[pick.lane];
      const now = Date.now();
      // Page work over its share of the minute yields to any other
      // background waiter (fill storage, snapshots, sweeps).
      const skipPage = pick.lane === "background" && lane.some((w) => !w.page) && lane.some((w) => w.page) && this.pageOverShare(now);
      let index = -1;
      for (let i = 0; i < lane.length; i++) {
        const a = lane[i];
        if (skipPage && a.page) continue;
        const b = lane[index];
        if (index < 0 || a.rank < b.rank || (a.rank === b.rank && a.seq < b.seq)) index = i;
      }
      const next = lane[index];
      this.refill(now);
      // Background leaves the reserve to live (and, below the interactive
      // ranks, a further share to page loads), unless it is its guaranteed
      // turn. A call heavier than what it may use waits for all of it.
      const reserve =
        pick.lane === "live" || pick.forced
          ? 0
          : next.rank <= INTERACTIVE_MAX_RANK
            ? this.liveReserve
            : this.liveReserve + this.interactiveReserve;
      const needed = Math.min(next.gate, this.capacity - reserve) + reserve;
      if (this.tokens < needed) {
        this.pumpTimer = setTimeout(
          () => {
            this.pumpTimer = undefined;
            this.pump();
          },
          Math.ceil((needed - this.tokens) / this.rate()),
        );
        return;
      }
      lane.splice(index, 1);
      this.tokens -= next.weight;
      this.liveStreak = pick.lane === "live" && this.queues.background.length > 0 ? this.liveStreak + 1 : 0;
      this.record(now, next.weight);
      if (next.page) {
        this.pageWindow.push({ ts: now, weight: next.weight });
        this.pageWindowWeight += next.weight;
      }
      next.cleanup();
      next.resolve();
    }
  }

  /**
   * Reports weight consumed that couldn't be known until after the
   * response arrived (userFillsByTime's per-20-items surcharge). Taken from
   * the bucket for future callers; never delays the caller that just
   * finished — the call already happened.
   */
  recordAdditionalWeight(weight: number): void {
    if (weight <= 0) return;
    const now = Date.now();
    this.refill(now);
    this.tokens -= weight;
    this.record(now, weight, false);
  }

  /**
   * Settles a call acquired with a worst-case estimate: a positive `delta`
   * is charged like `recordAdditionalWeight`, a negative one (the estimate
   * was too high) goes back to the bucket, and waiters may go at once.
   */
  adjust(delta: number): void {
    if (delta >= 0) {
      this.recordAdditionalWeight(delta);
      return;
    }
    const now = Date.now();
    this.refill(now);
    this.tokens = Math.min(this.capacity, this.tokens - delta);
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
    // Also empty the bucket, 2 s into debt, so we don't immediately retry
    // into another 429 while the lower rate takes effect.
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
    tokensAvailable: number;
    lastRateLimitedAt: Date | null;
  } {
    const now = Date.now();
    this.prune(now);
    this.refill(now);
    return {
      requestsLastMinute: this.window.filter((e) => e.request).length,
      weightLastMinute: this.window.reduce((sum, e) => sum + e.weight, 0),
      effectiveBudgetPerMin: this.effectiveBudgetPerMin,
      configuredBudgetPerMin: this.configuredBudgetPerMin,
      burstCapacity: this.capacity,
      tokensAvailable: this.tokens,
      lastRateLimitedAt: this.lastRateLimitedAt
        ? new Date(this.lastRateLimitedAt)
        : null,
    };
  }
}
