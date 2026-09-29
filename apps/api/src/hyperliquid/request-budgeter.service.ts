import { Injectable, Logger } from "@nestjs/common";

import { env } from "../config/env.js";

/**
 * Shared request-weight budgeter for every Hyperliquid `info` call (W6,
 * §4.2/§8). All REST call sites — the fast poll loop, delta-triggered
 * `userFillsByTime` fetches, A5 backfill pagination, and any future caller —
 * go through `acquire()` before they hit the network.
 *
 * ## Why this exists (the math, §8/§11)
 *
 * Hyperliquid's real, documented limits (hyperliquid.gitbook.io, verified
 * live 2026-09-29, not from training-data memory):
 *   - 1200 weight/minute per IP, shared across every info+exchange call.
 *   - `clearinghouseState` costs weight 2.
 *   - `userFillsByTime` (an "all other documented info request") costs a
 *     base weight of 20, PLUS an additional weight "per 20 items returned
 *     in the response". The docs page states this surcharge exists but,
 *     verified live by reading the page's own markup, does not spell out
 *     the per-20-items multiplier in that sentence. The standard reading
 *     (matching community/SDK conventions) is +1 weight per 20 items, i.e.
 *     `ceil(itemsReturned / 20)` extra — that is what this codebase assumes.
 *     Worst case (2000 items, the documented per-call cap) that is +100,
 *     i.e. a maxed-out call can cost up to 120 weight, not 20.
 *
 * The original PRD (§5, §8) assumed WS carried all real-time fills and REST
 * was only a 100-address/5-minute reconciliation poll: 100 × 2 × 12/hour =
 * 40 weight/min — trivially under any cap. Paul has approved dropping WS
 * entirely (documented HL limit is 10 unique users per IP across
 * user-specific WS subs, not 100/1000) — REST now carries the *entire*
 * pipeline: the fast poll AND every delta-triggered fill fetch. §8's "stay
 * under 70% of the 1200 cap" figure (840/min) was written for the old
 * 40 weight/min baseline; see `watcher.service.ts` for why 840 is still a
 * defensible cap even though the load composition changed completely —
 * short version: base poll cost is chosen to leave real headroom under 840,
 * and this budgeter's smoothing + backoff is the actual safety net, not the
 * particular cap number.
 *
 * ## Design
 *
 * A GCRA-style ("leaky bucket" / virtual scheduler) rate limiter:
 *   - `effectiveBudgetPerMin` starts at the configured cap and converts to
 *     a steady emission rate (weight/ms). Every unit of weight "costs" a
 *     fixed slice of time; acquiring weight `w` reserves the next `w *
 *     msPerWeight` of that timeline, starting no earlier than `now` and no
 *     earlier than the last reservation's end. That is what spaces calls
 *     out evenly across the window instead of letting 40 calls fire in the
 *     first second and then hard-blocking for the rest of the minute.
 *     Deliberately zero burst allowance: for this codebase's actual load
 *     shape (spread ~100 `clearinghouseState` calls evenly across a poll
 *     cycle, plus delta-triggered `userFillsByTime` calls), maximal
 *     smoothing is the goal, not a compromise — a burst allowance would
 *     just mean the first few calls of every cycle jump ahead for no
 *     benefit.
 *   - A sliding 60s log of `{ts, weight}` entries backs the introspection
 *     surface (`requestsLastMinute`, `weightLastMinute`) the health
 *     endpoint reports — pruned lazily on every call.
 *   - On a real 429, `effectiveBudgetPerMin` is halved (down to a floor of
 *     20% of the configured cap) and recovers by 10% of the configured cap
 *     per sustained success streak of 20 calls — standard adaptive
 *     backoff-and-recover shape, not a hard fail.
 *   - `userFillsByTime`'s item-count surcharge is only known after the
 *     response arrives, so callers `acquire()` the known base weight
 *     up-front (which does the spacing/wait), then report the surcharge
 *     afterwards via `recordAdditionalWeight()`, which extends the
 *     scheduler's timeline for *future* callers without making the
 *     already-completed call wait on itself.
 */
@Injectable()
export class RequestBudgeterService {
  private readonly logger = new Logger(RequestBudgeterService.name);

  /** {ts: epoch ms, weight} log, trimmed to the trailing 60s on each touch. */
  private readonly window: { ts: number; weight: number }[] = [];

  private readonly configuredBudgetPerMin: number;
  private effectiveBudgetPerMin: number;
  private readonly floorBudgetPerMin: number;

  /** GCRA "theoretical arrival time" cursor, in epoch ms. */
  private nextSlotEndsAt = 0;

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

  private record(ts: number, weight: number): void {
    this.window.push({ ts, weight });
    this.prune(Date.now());
  }

  /**
   * Reserves `weight` units of budget, sleeping as needed so calls stay
   * spaced out over the window rather than bursting. Resolves once it is
   * safe to actually issue the request.
   *
   * Pure virtual-scheduling (GCRA-style, zero burst allowance): each call
   * is scheduled to start no earlier than `max(now, nextSlotEndsAt)`, and
   * `nextSlotEndsAt` advances by that call's time-cost. Deliberately no
   * burst tolerance — for this codebase's use case (pacing ~100
   * `clearinghouseState` calls per poll cycle, plus delta-triggered
   * `userFillsByTime` calls) letting a handful of calls jump the queue
   * buys nothing: the very first poll cycle *should* spread its calls
   * across the interval rather than firing them all at t=0, so maximal
   * smoothing is the desired behavior, not a compromise. `record()`
   * happens once the call actually starts (after any wait), so the
   * sliding-window introspection reflects real send times.
   */
  async acquire(weight: number): Promise<void> {
    const now = Date.now();
    this.prune(now);

    const cost = weight * this.msPerWeight();
    const start = Math.max(now, this.nextSlotEndsAt);
    this.nextSlotEndsAt = start + cost;

    const waitMs = start - now;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    this.record(start, weight);
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
    this.record(now, weight);
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
      requestsLastMinute: this.window.length,
      weightLastMinute: this.window.reduce((sum, e) => sum + e.weight, 0),
      effectiveBudgetPerMin: this.effectiveBudgetPerMin,
      configuredBudgetPerMin: this.configuredBudgetPerMin,
      lastRateLimitedAt: this.lastRateLimitedAt
        ? new Date(this.lastRateLimitedAt)
        : null,
    };
  }
}
