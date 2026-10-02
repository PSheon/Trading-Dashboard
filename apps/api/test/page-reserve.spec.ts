import { testConfig } from "./config-test-utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  budgetConsumer,
  MIN_BACKGROUND_FACTOR,
  PAGE_RANK,
  PAGE_SHARE,
  PageBusyError,
  RequestBudgeterService,
} from "../src/hyperliquid/request-budgeter.service.js";
import { withRequestSignal } from "../src/runtime/request-context.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

/** Runs `work` as if inside an HTTP request from `client`. */
function asClient<T>(client: string, work: () => T): T {
  return withRequestSignal(new AbortController().signal, work, undefined, { client, answered: new AbortController().signal });
}

type Budget = Pick<RequestBudgeterService, "acquire" | "adjust" | "introspect" | "onModuleDestroy" | "queued">;

/**
 * The load the gap analysis measured (2026-10-01): background queues full of
 * fill lists (sweeps, backfill, pool ledger builds, history jobs), unranked
 * 20-weight reads (pool portfolios, cohort states) and the watcher's live
 * calls, at the default 840/min + 200 burst. Then cold trader pages arrive.
 */
async function simulate(budget: Budget, { pages = 3, gapMs = 20_000 } = {}) {
  const stop = new AbortController();
  let backgroundSent = 0;
  const liveWaits: number[] = [];
  // Four list streams: 120 worst-case up front, 60 refunded after the response.
  const list = async () => {
    while (!stop.signal.aborted) {
      try { await budget.acquire(120, "background", undefined, { known: 20, signal: stop.signal }); } catch { return; }
      backgroundSent += 1;
      await new Promise((r) => setTimeout(r, 300));
      budget.adjust(-60);
    }
  };
  // Two streams of unranked 20-weight reads (pool, cohort).
  const reads = async () => {
    while (!stop.signal.aborted) {
      try { await budget.acquire(20, "background", undefined, { signal: stop.signal }); } catch { return; }
      backgroundSent += 1;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  // The watcher: a live clearinghouse read every 2 s, timed.
  const live = async () => {
    while (!stop.signal.aborted) {
      const at = Date.now();
      try { await budget.acquire(2, "live", undefined, { signal: stop.signal }); } catch { return; }
      liveWaits.push(Date.now() - at);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  };
  const streams = [list(), list(), list(), list(), reads(), reads(), live()];
  await vi.advanceTimersByTimeAsync(60_000); // saturated steady state
  const sentBefore = backgroundSent;

  // A cold trader page from one client: the profile's calls (dex list, 9
  // clearinghouse states, spot, account mode, staking, the price book) at
  // the first-paint rank, the chart, then the activity's two fill lists.
  const results: Array<{ firstPaintMs: number; chartMs: number; listsMs: number; refused: number }> = [];
  for (let n = 0; n < pages; n++) {
    const started = Date.now();
    let refused = 0;
    const timed = (p: Promise<void>) => p.then(() => Date.now() - started, (e: unknown) => { if (e instanceof PageBusyError) refused += 1; return Infinity; });
    const page = asClient(`203.0.113.${n}`, () => ({
      profile: Promise.all([
        timed(budget.acquire(20, "background", PAGE_RANK.profile)),
        ...Array.from({ length: 9 }, () => timed(budget.acquire(2, "background", PAGE_RANK.profile))),
        ...[2, 20, 20, 22].map((w) => timed(budget.acquire(w, "background", PAGE_RANK.profile))),
      ]),
      chart: timed(budget.acquire(20, "background", PAGE_RANK.portfolio)),
      // The fill list of an active trader is full (120 real); the TWAP slice
      // list is nearly empty and refunds 95 once its response is in.
      lists: Promise.all([0, 1].map((i) => timed(budget.acquire(120, "background", PAGE_RANK.fills, { known: 20 }).then(() => { if (i === 1) setTimeout(() => budget.adjust(-95), 300); })))),
    }));
    await vi.advanceTimersByTimeAsync(gapMs);
    // Fake timers: advance until the page's calls have all settled (≤ 60 s).
    let settled: [number[], number, number[]] | undefined;
    void Promise.all([page.profile, page.chart, page.lists]).then((v) => { settled = v; });
    for (let i = 0; i < 120 && !settled; i++) await vi.advanceTimersByTimeAsync(500);
    const [profile, chart, lists] = settled ?? [[Infinity], Infinity, [Infinity]];
    results.push({ firstPaintMs: Math.max(...profile), chartMs: chart, listsMs: Math.max(...lists), refused });
  }
  await vi.advanceTimersByTimeAsync(20_000);
  const sentDuring = backgroundSent - sentBefore;
  stop.abort();
  budget.onModuleDestroy();
  // The streams are parked on fake timers: fire them so the loops exit.
  await vi.runOnlyPendingTimersAsync();
  await Promise.allSettled(streams);
  return { results, sentDuring, liveWaits, peakWeight: budget.introspect().weightLastMinute };
}

describe("page reserve: interactive page work under saturated background queues (840/min, burst 200)", () => {
  it("dispatches a cold profile + chart within a second, the fill lists within 4 s, with no 503 and background still moving", { timeout: 120_000 }, async () => {
    vi.useFakeTimers();
    vi.stubEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", undefined);
    vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", undefined);
    const budget = new RequestBudgeterService(testConfig());
    // Two cold pages a minute (≈ 270 weight each) on top of saturated jobs.
    const sim = await simulate(budget, { gapMs: 30_000 });
    for (const page of sim.results) {
      expect(page.refused).toBe(0);
      expect(page.firstPaintMs).toBeLessThanOrEqual(1_000);
      expect(page.chartMs).toBeLessThanOrEqual(1_500);
      expect(page.listsMs).toBeLessThanOrEqual(4_000);
    }
    // Background work kept going during the pages, and live never waited.
    expect(sim.sentDuring).toBeGreaterThan(5);
    expect(Math.max(...sim.liveWaits)).toBeLessThanOrEqual(50);
    // The trailing minute never exceeds budget + burst.
    expect(sim.peakWeight).toBeLessThanOrEqual(840 + 200);
  });

  it("background jobs cannot drain the reserve, however deep the main bucket's debt", async () => {
    vi.useFakeTimers();
    vi.stubEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", "840");
    vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", "200");
    const budget = new RequestBudgeterService(testConfig());
    for (let i = 0; i < 20; i++) void budget.acquire(120, "background", undefined, { known: 20 }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    const { reserveTokens, reserveCapacity, tokensAvailable } = budget.introspect();
    expect(reserveTokens).toBe(reserveCapacity);
    expect(tokensAvailable - reserveTokens).toBeLessThan(0);
    // The reserve (120) covers a whole first paint (102) at once.
    const sent: number[] = [];
    void budget.acquire(102, "background", PAGE_RANK.profile).then(() => sent.push(Date.now()));
    const at = Date.now();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([at]);
    budget.onModuleDestroy();
  });

  it("a flood of first paints still leaves other background work its share: the reserve's refill is the pages' floor", { timeout: 60_000 }, async () => {
    vi.useFakeTimers();
    vi.stubEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", "600");
    vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", "200");
    const budget = new RequestBudgeterService(testConfig());
    await budget.acquire(200, "live"); // start empty
    let pageWeight = 0;
    let stored = 0;
    let n = 0;
    const feed = (): void => {
      void asClient(`198.51.100.${n++ % 250}`, () => budget.acquire(20, "background", PAGE_RANK.profile))
        .then(() => { pageWeight += 20; feed(); }, () => undefined);
    };
    for (let i = 0; i < 5; i++) feed();
    const store = (): void => {
      budget.acquire(20, "background").then(() => { stored += 1; store(); }, () => undefined);
    };
    store();
    await vi.advanceTimersByTimeAsync(600_000);
    const total = pageWeight + stored * 20;
    // Pages got their share and no more; storage got the rest.
    expect(pageWeight / total).toBeLessThanOrEqual(PAGE_SHARE + 0.1);
    expect(pageWeight / total).toBeGreaterThanOrEqual(budget.pageReserveShare - 0.05);
    expect(stored).toBeGreaterThan(0);
    budget.onModuleDestroy();
  });
});

describe("consumer accounting, caps and the adaptive factor", () => {
  it("accounts every call to the consumer label of its async context; page work and live are labelled by default", async () => {
    vi.useFakeTimers();
    vi.stubEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", "840");
    vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", "200");
    const budget = new RequestBudgeterService(testConfig());
    await budgetConsumer("pool.performance", () => budget.acquire(20));
    await budgetConsumer("cohort", async () => { await budget.acquire(2); await budget.acquire(2); });
    await budget.acquire(20, "background", PAGE_RANK.profile);
    await budget.acquire(2, "live");
    await budget.acquire(6);
    expect(budget.introspect().consumers).toEqual({ "pool.performance": 20, cohort: 4, page: 20, live: 2, other: 6 });
  });

  it("a capped consumer's calls wait for its own bucket while the main bucket is full", async () => {
    vi.useFakeTimers();
    vi.stubEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", "840");
    vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", "200");
    const budget = new RequestBudgeterService(testConfig());
    budget.setConsumerCaps({ history: 60 });
    const sent: number[] = [];
    const t0 = Date.now();
    // 2 minutes may be saved up: 120 weight go now, the rest at 60/min.
    for (let i = 0; i < 9; i++) void budgetConsumer("history", () => budget.acquire(20)).then(() => sent.push(Date.now() - t0));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(3); // 60 of the main bucket's usable 72 at once, then...
    await vi.advanceTimersByTimeAsync(10_000);
    // ...the rest of the saved-up 120 as the main bucket refills, and one
    // more once the cap's bucket is above zero again (it may go negative
    // by one call, like the main bucket).
    expect(sent).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent.length).toBeGreaterThanOrEqual(8);
    expect(sent.length).toBeLessThanOrEqual(9);
    // Other consumers are not held back by the cap.
    const other: string[] = [];
    void budget.acquire(20).then(() => other.push("other"));
    await vi.advanceTimersByTimeAsync(0);
    expect(other).toEqual(["other"]);
    budget.onModuleDestroy();
  });

  it("the adaptive factor is 1 while page work is within the reserve's share and falls to the floor at the page share", async () => {
    vi.useFakeTimers();
    vi.stubEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", "840");
    vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", "200");
    const budget = new RequestBudgeterService(testConfig());
    expect(budget.backgroundFactor()).toBe(1);
    const pageWork = async (calls: number, ms: number) => {
      const all = Promise.all(Array.from({ length: calls }, () => budget.acquire(21, "background", PAGE_RANK.fills)));
      await vi.advanceTimersByTimeAsync(ms);
      await all;
    };
    // 210 of page work (25% of 840): still 1.
    await pageWork(10, 12_000);
    expect(budget.backgroundFactor()).toBe(1);
    // Halfway to the page share (420): halfway to the floor.
    await pageWork(5, 8_000);
    expect(budget.backgroundFactor()).toBeCloseTo(1 - 0.5 * (1 - MIN_BACKGROUND_FACTOR), 6);
    await pageWork(5, 8_000);
    expect(budget.backgroundFactor()).toBeCloseTo(MIN_BACKGROUND_FACTOR, 6);
    // A minute later the window has drained.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(budget.backgroundFactor()).toBe(1);
    budget.onModuleDestroy();
  });
});
