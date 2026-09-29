import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PAGE_RANK, RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";

describe("RequestBudgeterService (W6)", () => {
  const saved = {
    budget: process.env.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN,
    burst: process.env.HYPERLIQUID_WEIGHT_BURST,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN = "600"; // 0.01 weight/ms: 100 ms per weight
    delete process.env.HYPERLIQUID_WEIGHT_BURST;
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const [key, value] of [
      ["HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", saved.budget],
      ["HYPERLIQUID_WEIGHT_BURST", saved.burst],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** A budgeter whose bucket starts empty (tests of ordering under load). */
  async function drained(burst = 20): Promise<RequestBudgeterService> {
    process.env.HYPERLIQUID_WEIGHT_BURST = String(burst);
    const budgeter = new RequestBudgeterService();
    await budgeter.acquire(burst, "live");
    return budgeter;
  }

  it("lets a burst up to the bucket go out at once", async () => {
    process.env.HYPERLIQUID_WEIGHT_BURST = "200";
    const budgeter = new RequestBudgeterService();
    const released: number[] = [];
    const calls = Array.from({ length: 12 }, (_, i) => budgeter.acquire(20, "live").then(() => released.push(i)));
    await vi.advanceTimersByTimeAsync(0);
    // 10 × 20 = the whole bucket, immediately; the 11th waits 2 s for 20 tokens.
    expect(released).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(1999);
    expect(released).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toHaveLength(11);
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(calls);
  });

  it("caps the sustained rate at the budget (plus one bucket)", async () => {
    process.env.HYPERLIQUID_WEIGHT_BURST = "200";
    const budgeter = new RequestBudgeterService();
    // Demand of 800 calls × 2 = 1600 weight, far over 600/min.
    let done = 0;
    const calls = Array.from({ length: 800 }, () =>
      budgeter.acquire(2).then(() => {
        done += 1;
        budgeter.onSuccess();
      }),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(budgeter.introspect().weightLastMinute).toBeLessThanOrEqual(200);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(budgeter.introspect().weightLastMinute).toBeLessThanOrEqual(600 + 200 + 2);
    // The second minute gets only the refill: the budget.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(budgeter.introspect().weightLastMinute).toBeLessThanOrEqual(600 + 2);
    expect(done).toBeLessThanOrEqual((200 + 1200) / 2 + 1);
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(calls);
  });

  it("keeps the burst under Hyperliquid's 1200/min when the budget is set high", () => {
    process.env.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN = "1100";
    process.env.HYPERLIQUID_WEIGHT_BURST = "500";
    expect(new RequestBudgeterService().introspect().burstCapacity).toBe(100);
  });

  it("backs off the effective budget on a real 429 and recovers gradually on sustained success", async () => {
    const budgeter = new RequestBudgeterService();

    expect(budgeter.introspect().effectiveBudgetPerMin).toBe(600);

    budgeter.onRateLimited();
    const afterBackoff = budgeter.introspect();
    expect(afterBackoff.effectiveBudgetPerMin).toBeLessThan(600);
    expect(afterBackoff.effectiveBudgetPerMin).toBeGreaterThanOrEqual(600 * 0.2); // floor
    expect(afterBackoff.tokensAvailable).toBeLessThan(0); // nothing goes out for a while

    // Sustained success should climb back up, not jump straight to 600.
    for (let i = 0; i < 20; i++) budgeter.onSuccess();
    const afterRecovery = budgeter.introspect();
    expect(afterRecovery.effectiveBudgetPerMin).toBeGreaterThan(afterBackoff.effectiveBudgetPerMin);
    expect(afterRecovery.effectiveBudgetPerMin).toBeLessThanOrEqual(600);
  });

  it("never backs off below the configured floor even under repeated 429s", () => {
    const budgeter = new RequestBudgeterService();

    for (let i = 0; i < 20; i++) budgeter.onRateLimited();
    expect(budgeter.introspect().effectiveBudgetPerMin).toBeGreaterThanOrEqual(600 * 0.2 - 1);
  });

  it("records additional (post-hoc) weight without delaying the call that reported it", async () => {
    const budgeter = new RequestBudgeterService();

    await budgeter.acquire(20); // base userFillsByTime weight
    budgeter.recordAdditionalWeight(5); // e.g. a 100-item response surcharge

    const introspect = budgeter.introspect();
    expect(introspect.weightLastMinute).toBe(25);
    expect(introspect.requestsLastMinute).toBe(1); // the surcharge is not a request
    expect(introspect.tokensAvailable).toBe(200 - 25);
  });

  it("orders waiters within a lane by rank", async () => {
    const budgeter = await drained();
    const order: string[] = [];
    const first = budgeter.acquire(20, "live", 5).then(() => order.push("first"));
    await vi.advanceTimersByTimeAsync(0);
    const busyBot = budgeter.acquire(20, "live", 1_000).then(() => order.push("bot"));
    const quietWhale = budgeter.acquire(20, "live", 10).then(() => order.push("whale"));
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([first, busyBot, quietWhale]);
    expect(order).toEqual(["first", "whale", "bot"]);
  });

  it("releases live waiters before queued background ones", async () => {
    const budgeter = await drained();
    const order: string[] = [];
    const background = Array.from({ length: 5 }, (_, i) =>
      budgeter.acquire(20, "background").then(() => order.push(`bg${i}`)),
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(order).toEqual(["bg0"]);
    const live = budgeter.acquire(2, "live").then(() => order.push("live"));
    expect(budgeter.queued()).toEqual({ live: 1, background: 4 });

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([...background, live]);
    // bg0 was already out; the live call goes next, ahead of bg1..bg4.
    expect(order).toEqual(["bg0", "live", "bg1", "bg2", "bg3", "bg4"]);
  });

  it("gives live the next tokens even while a heavy background call is waiting for them", async () => {
    const budgeter = await drained();
    const order: string[] = [];
    const heavy = budgeter.acquire(20, "background").then(() => order.push("heavy"));
    await vi.advanceTimersByTimeAsync(500); // heavy needs 2 s of refill
    const live = budgeter.acquire(2, "live").then(() => order.push("live"));
    // 5 tokens are there: live goes now, not after the heavy call's 2 s.
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["live"]);
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([heavy, live]);
    expect(order).toEqual(["live", "heavy"]);
  });

  it("leaves the last 10% of the bucket to live and 20% more to first paints: page loads can't drain it", async () => {
    process.env.HYPERLIQUID_WEIGHT_BURST = "200";
    const budgeter = new RequestBudgeterService();
    const released: string[] = [];
    // Unranked background (sweeps, backfill) leaves 20 + 40: seven calls of
    // 20 fit in 140; the eighth would eat the reserves.
    for (let i = 0; i < 10; i++) void budgeter.acquire(20, "background").then(() => released.push(`bg${i}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toHaveLength(7);
    // A first paint (rank 0) and a chart (rank 1) may use the interactive
    // share; fill lists (rank 2) may not. None may touch live's 20.
    void budgeter.acquire(20, "background", PAGE_RANK.fills).then(() => released.push("fills"));
    void budgeter.acquire(20, "background", PAGE_RANK.profile).then(() => released.push("profile"));
    void budgeter.acquire(20, "background", PAGE_RANK.portfolio).then(() => released.push("portfolio"));
    void budgeter.acquire(20, "background", PAGE_RANK.profile).then(() => released.push("profile2"));
    await vi.advanceTimersByTimeAsync(0);
    expect(released.slice(7)).toEqual(["profile", "portfolio"]);
    void budgeter.acquire(2, "live").then(() => released.push("live"));
    await vi.advanceTimersByTimeAsync(0);
    expect(released[released.length - 1]).toBe("live");
  });

  it("serves the lowest page rank first and builds tokens up for it, whatever arrives behind it", async () => {
    const budgeter = await drained(); // 20-token bucket, empty; 100 ms per token
    const order: string[] = [];
    const calls = [
      budgeter.acquire(2, "background").then(() => order.push("sweep")),
      budgeter.acquire(12, "background", PAGE_RANK.fills).then(() => order.push("fills")),
      budgeter.acquire(2, "background", PAGE_RANK.warm).then(() => order.push("warm")),
      budgeter.acquire(10, "background", PAGE_RANK.profile).then(() => order.push("profile")),
    ];
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(calls);
    expect(order).toEqual(["profile", "fills", "warm", "sweep"]);
  });

  it("lets a page's list call go on its known base; a background list waits for its whole worst case", async () => {
    process.env.HYPERLIQUID_WEIGHT_BURST = "200"; // reserves: live 20 + page 40; 14 tokens/s at 840/min
    const budgeter = new RequestBudgeterService();
    await budgeter.acquire(100, "live"); // 100 left
    const order: string[] = [];
    // A sweep's list: 120 up front (20 base + worst-case 100) needs 180.
    void budgeter.acquire(120, "background", undefined, 20).then(() => order.push("sweep"));
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([]);
    // A trader page's list: goes on 20 + 60, taking the bucket to -20.
    void budgeter.acquire(120, "background", PAGE_RANK.fills, 20).then(() => order.push("page"));
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["page"]);
    expect(budgeter.introspect().tokensAvailable).toBe(-20);
  });

  it("settles a worst-case estimate: a refund goes back to the bucket and wakes waiters", async () => {
    process.env.HYPERLIQUID_WEIGHT_BURST = "200";
    const budgeter = new RequestBudgeterService();
    await budgeter.acquire(120); // a list call's base + worst-case surcharge
    const released: string[] = [];
    void budgeter.acquire(100, "background", PAGE_RANK.profile).then(() => released.push("next"));
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toEqual([]); // 80 left, 100 + 20 reserve needed
    budgeter.adjust(-97); // the list had 60 items: 3 of the 100 were used
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toEqual(["next"]);
    expect(budgeter.introspect().weightLastMinute).toBe(120 - 97 + 100);
    budgeter.adjust(5); // more than estimated: charged like a surcharge
    expect(budgeter.introspect().tokensAvailable).toBeCloseTo(200 - 23 - 100 - 5, 0);
  });

  it("sends at least one in four dispatches to background while live keeps coming (starvation guard)", async () => {
    const budgeter = await drained();
    const order: string[] = [];
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 3; i++) calls.push(budgeter.acquire(2, "background").then(() => order.push("bg")));
    for (let i = 0; i < 9; i++) calls.push(budgeter.acquire(2, "live").then(() => order.push("live")));
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(calls);
    expect(order).toEqual(["live", "live", "live", "bg", "live", "live", "live", "bg", "live", "live", "live", "bg"]);
  });

  it("runs a call heavier than the whole bucket once the bucket is full, taking it into debt", async () => {
    process.env.HYPERLIQUID_WEIGHT_BURST = "50";
    const budgeter = new RequestBudgeterService();
    const order: string[] = [];
    await budgeter.acquire(10, "live");
    const oversize = budgeter.acquire(120, "background").then(() => order.push("oversize"));
    const after = budgeter.acquire(2, "background").then(() => order.push("after"));
    // Needs a full bucket (50): 10 tokens refill in 1 s.
    await vi.advanceTimersByTimeAsync(999);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["oversize"]);
    expect(budgeter.introspect().tokensAvailable).toBe(50 - 120);
    // The next caller pays off the debt first: 70 + 5 (live reserve) + 10
    // (page reserve) + 2 → 8.7 s.
    await vi.advanceTimersByTimeAsync(8_600);
    expect(order).toEqual(["oversize"]);
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([oversize, after]);
    expect(order).toEqual(["oversize", "after"]);
  });
});
