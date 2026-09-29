import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";

describe("RequestBudgeterService (W6)", () => {
  const originalBudgetEnv = process.env.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalBudgetEnv === undefined) {
      delete process.env.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN;
    } else {
      process.env.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN = originalBudgetEnv;
    }
  });

  it("smooths a burst so the trailing-60s window never exceeds the configured cap", async () => {
    process.env.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN = "600";
    const budgeter = new RequestBudgeterService();

    // Demand (400 calls x weight 2 = 800/min) exceeds the 600/min cap —
    // if this were a naive "burst then block" limiter, the first ~300
    // calls would fire immediately (600 weight) and the window would spike
    // to the cap instantly. A smoothing limiter instead spaces all 400
    // calls out over roughly (800/600) minutes.
    const calls = Array.from({ length: 400 }, () => budgeter.acquire(2).then(() => budgeter.onSuccess()));

    // Right after issuing the burst (0ms elapsed), zero burst allowance
    // means only the very first call has actually gone out — nowhere near
    // the full cap despite 400 calls being queued up.
    await vi.advanceTimersByTimeAsync(0);
    const immediately = budgeter.introspect();
    expect(immediately.weightLastMinute).toBeLessThanOrEqual(2);

    // 60 real seconds later, the trailing window is still capped at
    // (roughly) the configured budget — smoothing, not a bigger burst.
    await vi.advanceTimersByTimeAsync(60_000);
    const afterOneMinute = budgeter.introspect();
    expect(afterOneMinute.weightLastMinute).toBeLessThanOrEqual(600 * 1.1);

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(calls);
  });

  it("backs off the effective budget on a real 429 and recovers gradually on sustained success", async () => {
    process.env.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN = "600";
    const budgeter = new RequestBudgeterService();

    expect(budgeter.introspect().effectiveBudgetPerMin).toBe(600);

    budgeter.onRateLimited();
    const afterBackoff = budgeter.introspect();
    expect(afterBackoff.effectiveBudgetPerMin).toBeLessThan(600);
    expect(afterBackoff.effectiveBudgetPerMin).toBeGreaterThanOrEqual(600 * 0.2); // floor

    // Sustained success should climb back up, not jump straight to 600.
    for (let i = 0; i < 20; i++) budgeter.onSuccess();
    const afterRecovery = budgeter.introspect();
    expect(afterRecovery.effectiveBudgetPerMin).toBeGreaterThan(afterBackoff.effectiveBudgetPerMin);
    expect(afterRecovery.effectiveBudgetPerMin).toBeLessThanOrEqual(600);
  });

  it("never backs off below the configured floor even under repeated 429s", () => {
    process.env.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN = "600";
    const budgeter = new RequestBudgeterService();

    for (let i = 0; i < 20; i++) budgeter.onRateLimited();
    expect(budgeter.introspect().effectiveBudgetPerMin).toBeGreaterThanOrEqual(600 * 0.2 - 1);
  });

  it("records additional (post-hoc) weight without delaying the call that reported it", async () => {
    process.env.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN = "600";
    const budgeter = new RequestBudgeterService();

    await budgeter.acquire(20); // base userFillsByTime weight
    budgeter.recordAdditionalWeight(5); // e.g. a 100-item response surcharge

    const introspect = budgeter.introspect();
    expect(introspect.weightLastMinute).toBe(25);
    expect(introspect.requestsLastMinute).toBe(2); // two log entries
  });
});
