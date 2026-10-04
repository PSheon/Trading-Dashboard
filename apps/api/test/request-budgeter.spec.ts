import { testConfig } from "./config-test-utils.js";
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
    const budgeter = new RequestBudgeterService(testConfig());
    await budgeter.acquire(burst, "live");
    return budgeter;
  }

  describe("a new process (redeploys overlap the instance they replace)", () => {
    afterEach(() => { delete process.env.HYPERLIQUID_STARTUP_PACE_SECONDS; });

    it("starts with empty buckets and half its rate for the first minute, then runs at the full rate with its burst", async () => {
      process.env.HYPERLIQUID_WEIGHT_BURST = "200";
      process.env.HYPERLIQUID_STARTUP_PACE_SECONDS = "60";
      const budgeter = new RequestBudgeterService(testConfig());
      expect(budgeter.introspect().tokensAvailable).toBe(0);
      const sent: number[] = [];
      const started = Date.now();
      // Saturated: live and background callers, more than a minute's budget of each.
      const calls = [
        ...Array.from({ length: 400 }, () => budgeter.acquire(2, "live").then(() => sent.push(Date.now() - started))),
        ...Array.from({ length: 400 }, () => budgeter.acquire(2).then(() => sent.push(Date.now() - started))),
      ];
      await vi.advanceTimersByTimeAsync(0);
      // Nothing goes out at once: no burst to spend.
      expect(sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(60_000);
      const firstMinute = sent.length * 2;
      // 600/min at 50 %: 300 in the first minute (the instance being replaced may be sending its 600 + burst).
      expect(firstMinute).toBeGreaterThanOrEqual(298);
      expect(firstMinute).toBeLessThanOrEqual(300);
      // Evenly, not as a burst at the end: half of it by half time.
      expect(sent.filter((at) => at <= 30_000).length * 2).toBeLessThanOrEqual(150);
      await vi.advanceTimersByTimeAsync(60_000);
      // The second minute runs at the full 600.
      expect(sent.length * 2 - firstMinute).toBeGreaterThanOrEqual(598);
      expect(sent.length * 2 - firstMinute).toBeLessThanOrEqual(600);
      await vi.advanceTimersByTimeAsync(120_000);
      await Promise.all(calls);
      // Idle afterwards, the buckets fill to the configured burst.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(budgeter.introspect().tokensAvailable).toBe(200);
    });

    it("a wait that spans the end of the start-up period is timed at both rates", async () => {
      process.env.HYPERLIQUID_WEIGHT_BURST = "200";
      process.env.HYPERLIQUID_STARTUP_PACE_SECONDS = "10";
      const budgeter = new RequestBudgeterService(testConfig());
      let done = false;
      // 80 weight: 10 s at 5/s give 50, the other 30 take 3 s at 10/s.
      const call = budgeter.acquire(80, "live").then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(12_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      await call;
    });

    it("HYPERLIQUID_STARTUP_PACE_SECONDS=0 keeps the full burst and rate from the first call", async () => {
      process.env.HYPERLIQUID_WEIGHT_BURST = "200";
      process.env.HYPERLIQUID_STARTUP_PACE_SECONDS = "0";
      const budgeter = new RequestBudgeterService(testConfig());
      expect(budgeter.introspect().tokensAvailable).toBe(200);
    });
  });

  it("lets a burst up to the bucket go out at once", async () => {
    process.env.HYPERLIQUID_WEIGHT_BURST = "200";
    const budgeter = new RequestBudgeterService(testConfig());
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
    const budgeter = new RequestBudgeterService(testConfig());
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
    expect(new RequestBudgeterService(testConfig()).introspect().burstCapacity).toBe(100);
  });

  it("backs off the effective budget on a real 429 and recovers gradually on sustained success", async () => {
    const budgeter = new RequestBudgeterService(testConfig());

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
    const budgeter = new RequestBudgeterService(testConfig());

    for (let i = 0; i < 20; i++) budgeter.onRateLimited();
    expect(budgeter.introspect().effectiveBudgetPerMin).toBeGreaterThanOrEqual(600 * 0.2 - 1);
  });

  it("records additional (post-hoc) weight without delaying the call that reported it", async () => {
    const budgeter = new RequestBudgeterService(testConfig());

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
    // The reserve has refilled a little: live goes at once, ahead of bg1..bg4,
    // while the main bucket is still in bg0's debt.
    await vi.advanceTimersByTimeAsync(0);
    expect(budgeter.queued()).toEqual({ live: 0, background: 4 });

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([...background, live]);
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

  it("keeps the page reserve for first paints and the chart, and the last 10% of the main bucket for live", async () => {
    process.env.HYPERLIQUID_WEIGHT_BURST = "200"; // main 80 (live keeps 8), page reserve 120
    const budgeter = new RequestBudgeterService(testConfig());
    expect(budgeter.introspect()).toMatchObject({ burstCapacity: 200, reserveCapacity: 120, reserveTokens: 120 });
    const released: string[] = [];
    // Unranked background (sweeps, backfill) has the main bucket above
    // live's 8: three calls of 20 fit in 72; the fourth would eat it.
    for (let i = 0; i < 10; i++) void budgeter.acquire(20, "background").then(() => released.push(`bg${i}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toHaveLength(3);
    // A first paint (rank 0) and a chart (rank 1) spend the reserve; a
    // fill list (rank 2) may not, and waits for the main bucket.
    void budgeter.acquire(20, "background", PAGE_RANK.fills).then(() => released.push("fills"));
    void budgeter.acquire(20, "background", PAGE_RANK.profile).then(() => released.push("profile"));
    void budgeter.acquire(20, "background", PAGE_RANK.portfolio).then(() => released.push("portfolio"));
    void budgeter.acquire(20, "background", PAGE_RANK.profile).then(() => released.push("profile2"));
    await vi.advanceTimersByTimeAsync(0);
    expect(released.slice(3)).toEqual(["profile", "portfolio", "profile2"]);
    expect(budgeter.introspect().reserveTokens).toBe(60);
    // Live still has its 8 in the main bucket.
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
      budgeter.acquire(2, "background", PAGE_RANK.analytics).then(() => order.push("analytics")),
      budgeter.acquire(10, "background", PAGE_RANK.profile).then(() => order.push("profile")),
    ];
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(calls);
    expect(order).toEqual(["profile", "fills", "analytics", "sweep"]);
  });

  it("a background list takes the main bucket into debt; a first paint still goes at once; a page's list waits on its known base only", async () => {
    process.env.HYPERLIQUID_WEIGHT_BURST = "200"; // main 80 (live keeps 8), reserve 120; 10 tokens/s at 600/min
    const budgeter = new RequestBudgeterService(testConfig());
    const order: string[] = [];
    // A sweep's list: 120 up front (20 base + worst-case 100) needs the
    // whole usable main bucket (72), then takes it to -40.
    void budgeter.acquire(120, "background", undefined, { known: 20 }).then(() => order.push("sweep"));
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["sweep"]);
    expect(budgeter.introspect()).toMatchObject({ tokensAvailable: -40 + 120, reserveTokens: 120 });
    // The debt is the main bucket's: a first paint is served from the reserve now.
    void budgeter.acquire(20, "background", PAGE_RANK.profile).then(() => order.push("profile"));
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["sweep", "profile"]);
    // A trader page's list goes on its known 20 (+ live's 8) once the main
    // bucket is back there, after the reserve has refilled: 20 + 68 tokens
    // at 10/s.
    void budgeter.acquire(120, "background", PAGE_RANK.fills, { known: 20 }).then(() => order.push("page"));
    await vi.advanceTimersByTimeAsync(8_600);
    expect(order).toEqual(["sweep", "profile"]);
    await vi.advanceTimersByTimeAsync(400);
    expect(order).toEqual(["sweep", "profile", "page"]);
    expect(budgeter.introspect().reserveTokens).toBe(120);
    expect(budgeter.introspect().tokensAvailable).toBeLessThan(120 - 80);
  });

  it("settles a worst-case estimate: a refund goes back to the main bucket and wakes waiters", async () => {
    process.env.HYPERLIQUID_WEIGHT_BURST = "200"; // main 80 (live keeps 8), reserve 120
    const budgeter = new RequestBudgeterService(testConfig());
    await budgeter.acquire(120); // a list call's base + worst-case surcharge: main -40
    const released: string[] = [];
    void budgeter.acquire(40, "background").then(() => released.push("next"));
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toEqual([]); // -40, 40 + 8 reserve needed
    budgeter.adjust(-97); // the list had 60 items: 3 of the 100 were used
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toEqual(["next"]);
    expect(budgeter.introspect().weightLastMinute).toBe(120 - 97 + 40);
    budgeter.adjust(5); // more than estimated: charged like a surcharge
    expect(budgeter.introspect().tokensAvailable).toBeCloseTo(200 - 23 - 40 - 5, 0);
  });

  it("sends at least one in four dispatches to background while live keeps coming (starvation guard)", async () => {
    const budgeter = await drained();
    const order: string[] = [];
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 3; i++) calls.push(budgeter.acquire(2, "background").then(() => order.push("bg")));
    for (let i = 0; i < 9; i++) calls.push(budgeter.acquire(2, "live").then(() => order.push("live")));
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(calls);
    // Live goes first and keeps going on the reserve; background is never
    // starved: each background call goes out among the live ones, not after
    // them all (live spends the reserve first, so the main bucket fills for it).
    expect(order[0]).toBe("live");
    expect(order.filter((x) => x === "bg")).toHaveLength(3);
    expect(order.lastIndexOf("live")).toBeGreaterThan(order.indexOf("bg"));
    expect(order.indexOf("bg")).toBeLessThanOrEqual(3);
  });

  it("runs a call heavier than the whole bucket once the bucket is full, taking it into debt", async () => {
    process.env.HYPERLIQUID_WEIGHT_BURST = "50"; // main 20 (live keeps 2), reserve 30
    const budgeter = new RequestBudgeterService(testConfig());
    const order: string[] = [];
    await budgeter.acquire(10); // main 20 → 10
    const oversize = budgeter.acquire(120, "background").then(() => order.push("oversize"));
    const after = budgeter.acquire(2, "background").then(() => order.push("after"));
    // Needs a full main bucket (20 − live's 2): 10 tokens refill in 1 s.
    await vi.advanceTimersByTimeAsync(999);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["oversize"]);
    expect(budgeter.introspect()).toMatchObject({ tokensAvailable: 20 - 120 + 30, reserveTokens: 30 });
    // The next caller pays off the debt first: 100 + 2 (live reserve) + 2 → 10.4 s.
    await vi.advanceTimersByTimeAsync(10_300);
    expect(order).toEqual(["oversize"]);
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([oversize, after]);
    expect(order).toEqual(["oversize", "after"]);
  });
});
