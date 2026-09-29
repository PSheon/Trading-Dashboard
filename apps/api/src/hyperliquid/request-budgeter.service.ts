import { Injectable, Logger } from "@nestjs/common";

import { env } from "../config/env.js";

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
 * REST weight. REST carries (a) a `userFillsByTime` + `clearinghouseState`
 * burst per address that just traded, (b) the 5-minute snapshots, (c) the
 * hourly sweep and (d) A5 backfill. Only (a) is latency-sensitive, so it
 * runs in the `live` lane; everything else is `background`. The default cap
 * is PRD §8's 70% of 1200.
 *
 * ## Design
 *
 * Virtual-time pacing with two priority lanes. Each dispatched call reserves
 * `weight × msPerWeight` of timeline; the next waiter is released once that
 * slot has passed, always taking from the `live` queue before `background`.
 * So a 100-address backfill queued in `background` delays a live fetch by at
 * most one call's slot, instead of the live fetch waiting behind all of it.
 * No burst allowance: calls are spread evenly.
 *
 * On a real 429 the effective budget halves (floor 20% of the cap) and the
 * timeline is pushed 2 s out; it recovers by 10% of the cap per 20
 * consecutive successes. `userFillsByTime`'s surcharge is only known after
 * the response, so it is added to the timeline afterwards via
 * `recordAdditionalWeight()`, charging future callers rather than the call
 * that already happened.
 */
export type RequestPriority = "live" | "background";

interface Waiter {
  weight: number;
  resolve: () => void;
  /** Lower goes first within a lane; ties go in arrival order. */
  rank: number;
  seq: number;
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

  /** End of the most recently dispatched call's slot, in epoch ms. */
  private nextSlotEndsAt = 0;
  private readonly queues: Record<RequestPriority, Waiter[]> = { live: [], background: [] };
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;

  private consecutiveSuccesses = 0;
  private lastRateLimitedAt: number | undefined;

  constructor() {
    this.configuredBudgetPerMin = env.hyperliquidWeightBudgetPerMin();
    this.effectiveBudgetPerMin = this.configuredBudgetPerMin;
    this.floorBudgetPerMin = Math.max(
      1,
      Math.round(this.configuredBudgetPerMin * 0.2),
    );
  }

  /** How much wall-clock time one unit of weight currently costs. */
  private msPerWeight(): number {
    return 60_000 / this.effectiveBudgetPerMin;
  }

  private prune(now: number): void {
    const cutoff = now - 60_000;
    while (this.window.length > 0 && this.window[0].ts < cutoff) {
      this.window.shift();
    }
  }

  private record(ts: number, weight: number, request = true): void {
    this.window.push({ ts, weight, request });
    this.prune(Date.now());
  }

  /**
   * Resolves once it is this call's turn to go out. `live` waiters are
   * always released before `background` ones. Within a lane the lowest
   * `rank` goes first (default: arrival order). The watcher ranks a live
   * sync by when that address was last served, so an address that trades
   * once an hour isn't stuck behind bots that trade every second.
   */
  acquire(weight: number, priority: RequestPriority = "background", rank?: number): Promise<void> {
    return new Promise((resolve) => {
      const seq = this.seq++;
      this.queues[priority].push({ weight, resolve, rank: rank ?? seq, seq });
      this.pump();
    });
  }

  /** Waiters currently queued per lane (introspection and tests). */
  queued(): Record<RequestPriority, number> {
    return { live: this.queues.live.length, background: this.queues.background.length };
  }

  private pump(): void {
    if (this.pumpTimer) return;
    for (;;) {
      const lane = this.queues.live.length > 0 ? this.queues.live : this.queues.background;
      if (lane.length === 0) return;
      let index = 0;
      for (let i = 1; i < lane.length; i++) {
        const a = lane[i];
        const b = lane[index];
        if (a.rank < b.rank || (a.rank === b.rank && a.seq < b.seq)) index = i;
      }
      const next = lane[index];
      const now = Date.now();
      if (now < this.nextSlotEndsAt) {
        this.pumpTimer = setTimeout(() => {
          this.pumpTimer = undefined;
          this.pump();
        }, this.nextSlotEndsAt - now);
        return;
      }
      lane.splice(index, 1);
      this.nextSlotEndsAt = now + next.weight * this.msPerWeight();
      this.record(now, next.weight);
      next.resolve();
    }
  }

  /**
   * Reports weight consumed that couldn't be known until after the
   * response arrived (userFillsByTime's per-20-items surcharge). Extends
   * the scheduler timeline for future callers but never delays the caller
   * that just finished — the call already happened.
   */
  recordAdditionalWeight(weight: number): void {
    if (weight <= 0) return;
    const now = Date.now();
    this.nextSlotEndsAt = Math.max(this.nextSlotEndsAt, now) + weight * this.msPerWeight();
    this.record(now, weight, false);
  }

  /** Call after a successful (non-429) response, for gradual recovery. */
  onSuccess(): void {
    this.consecutiveSuccesses += 1;
    if (
      this.consecutiveSuccesses >= 20 &&
      this.effectiveBudgetPerMin < this.configuredBudgetPerMin
    ) {
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
    const next = Math.max(
      this.floorBudgetPerMin,
      Math.round(this.effectiveBudgetPerMin * 0.5),
    );
    this.logger.warn(
      `429 from Hyperliquid — backing off effective budget ${this.effectiveBudgetPerMin.toFixed(0)} -> ${next}/min`,
    );
    this.effectiveBudgetPerMin = next;
    // Also push the scheduler timeline out so we don't immediately retry
    // into another 429 while the lower rate takes effect.
    this.nextSlotEndsAt = Math.max(this.nextSlotEndsAt, Date.now() + 2000);
  }

  /** Introspection for the /health heartbeat (§8 可觀測). */
  introspect(): {
    requestsLastMinute: number;
    weightLastMinute: number;
    effectiveBudgetPerMin: number;
    configuredBudgetPerMin: number;
    lastRateLimitedAt: Date | null;
  } {
    this.prune(Date.now());
    return {
      requestsLastMinute: this.window.filter((e) => e.request).length,
      weightLastMinute: this.window.reduce((sum, e) => sum + e.weight, 0),
      effectiveBudgetPerMin: this.effectiveBudgetPerMin,
      configuredBudgetPerMin: this.configuredBudgetPerMin,
      lastRateLimitedAt: this.lastRateLimitedAt
        ? new Date(this.lastRateLimitedAt)
        : null,
    };
  }
}
