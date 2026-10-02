import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BudgetWaitError, budgetConsumer, CAPPED_SHARE, ESSENTIAL_RANK, PAGE_RANK, RequestBudgeterService, UNRANKED_BASE } from "../src/hyperliquid/request-budgeter.service.js";
import { SNAPSHOT_QUEUE_MS, SWEEP_QUEUE_MS } from "../src/scheduler/scheduler.service.js";
import { testConfig } from "./config-test-utils.js";

/** The admin's defaults (`discovery.*WeightPerMinute`): 640 a minute in all. */
const CAPS = { "pool.performance": 240, "pool.ledgers": 100, history: 120, backfill: 120, cohort: 60 };
const MINUTE = 60_000;
/** Dev on 2026-10-02: 20 watched leaders, about two dexes each. */
const LEADERS = 20;
const DEXES = 2;

describe("budget consumers: caps fit the process's budget and essential jobs are never starved", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", "100");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function budgeter(perMinute: number): RequestBudgeterService {
    vi.stubEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", String(perMinute));
    const budget = new RequestBudgeterService(testConfig());
    budget.setConsumerCaps(CAPS);
    return budget;
  }

  /**
   * The worker with every job wanting more than it may have, for `minutes`:
   * the pool's two loops, the history job, the backward backfill and an
   * unlabelled job, each with calls always waiting; the cohort loop reading
   * as fast as it is let; a snapshot run every 5 minutes (one account state
   * per leader and dex) and a sweep every 15 (a fill list and a TWAP list
   * per leader, acquired at their worst case and settled like the client does).
   */
  async function saturated(budget: RequestBudgeterService, minutes: number, { reportSuccess = false } = {}) {
    let stopped = false;
    const sent: Array<{ at: number; consumer: string; weight: number }> = [];
    const t0 = Date.now();
    const call = async (consumer: string, weight: number, rank?: number, settle = 0) => {
      await budget.acquire(weight, "background", rank);
      if (settle !== 0) budget.adjust(settle);
      // The client reports every answered call; 20 in a row raise a backed-off rate.
      if (reportSuccess) budget.onSuccess();
      sent.push({ at: Date.now() - t0, consumer, weight: weight + settle });
    };
    const loop = (consumer: string | null, weight: number, rank: number | undefined, lanes: number, settle = 0) => {
      for (let lane = 0; lane < lanes; lane++) {
        const run = async () => { while (!stopped) await call(consumer ?? "other", weight, rank, settle).catch(() => undefined); };
        void (consumer ? budgetConsumer(consumer, run) : run());
      }
    };
    // Portfolio reads (20) at the pool's rank; ledger and history pages are
    // fill lists (worst case 120, 60 after settling); backfill windows too.
    loop("pool.performance", 20, UNRANKED_BASE - 1, 4);
    loop("pool.ledgers", 120, UNRANKED_BASE, 2, -60);
    loop("history", 120, UNRANKED_BASE, 2, -60);
    loop("backfill", 120, undefined, 2, -60);
    loop(null, 20, undefined, 4);
    loop("cohort", 2, ESSENTIAL_RANK.cohort, 4);

    const runs: Array<{ job: "snapshots" | "sweep"; startedAt: number; ms: number | null; failed: number }> = [];
    const periodic = (job: "snapshots" | "sweep", everyMs: number, queueMs: number, work: () => Promise<unknown>[]) => {
      const start = () => {
        const run = { job, startedAt: Date.now() - t0, ms: null as number | null, failed: 0 };
        runs.push(run);
        void budgetConsumer(job, () => Promise.allSettled(work()), { queueMs }).then((results) => {
          run.failed = results.filter((result) => result.status === "rejected").length;
          run.ms = Date.now() - t0 - run.startedAt;
        });
      };
      start();
      const timer = setInterval(start, everyMs);
      return () => clearInterval(timer);
    };
    // Four leaders at a time, as the scheduler and the watcher run them.
    const leaders = (one: () => Promise<unknown>) => {
      let next = 0;
      const results: Promise<unknown>[] = [];
      const worker = async () => { while (next < LEADERS) { next += 1; const result = one(); results.push(result); await result.catch(() => undefined); } };
      return [Promise.all(Array.from({ length: 4 }, worker)).then(() => Promise.all(results))];
    };
    const stopSnapshots = periodic("snapshots", 5 * MINUTE, SNAPSHOT_QUEUE_MS, () => leaders(() => Promise.all(Array.from({ length: DEXES }, () => call("snapshots", 2)))));
    const stopSweeps = periodic("sweep", 15 * MINUTE, SWEEP_QUEUE_MS, () => leaders(async () => { await call("sweep", 120, undefined, -100); await call("sweep", 120, undefined, -100); }));

    await vi.advanceTimersByTimeAsync(minutes * MINUTE);
    stopped = true;
    stopSnapshots();
    stopSweeps();
    budget.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(0);

    const perMinute = (consumer?: string) => Array.from({ length: minutes }, (_, minute) =>
      sent.filter((entry) => (!consumer || entry.consumer === consumer) && entry.at >= minute * MINUTE && entry.at < (minute + 1) * MINUTE).reduce((sum, entry) => sum + entry.weight, 0));
    const average = (consumer?: string) => perMinute(consumer).reduce((sum, value) => sum + value, 0) / minutes;
    // Runs that had their whole period inside the simulation.
    const finished = (job: string, periodMs: number) => runs.filter((run) => run.job === job && run.startedAt + periodMs <= minutes * MINUTE);
    return { perMinute, average, finished };
  }

  it("the configured caps are maxima: together they take at most 75 % of the effective budget", () => {
    expect(CAPPED_SHARE).toBe(0.75);
    const caps = (budget: RequestBudgeterService) => budget.introspect().consumerCaps;
    // 1,000 a minute holds all 640: nothing is scaled. The default 840 gives them 630.
    expect(caps(budgeter(1000))).toEqual({ "pool.performance": 240, "pool.ledgers": 100, history: 120, backfill: 120, cohort: 60 });
    expect(caps(budgeter(840))).toEqual({ "pool.performance": 236, "pool.ledgers": 98, history: 118, backfill: 118, cohort: 59 });
    // 600: 450 for the capped jobs, in proportion.
    expect(caps(budgeter(600))).toEqual({ "pool.performance": 169, "pool.ledgers": 70, history: 84, backfill: 84, cohort: 42 });
    // 360 (the worker on Stage during the incident): 270.
    const worker = budgeter(360);
    expect(caps(worker)).toEqual({ "pool.performance": 101, "pool.ledgers": 42, history: 51, backfill: 51, cohort: 25 });
    // After a 429 the caps follow the backed-off rate, down to the floor (20 %: 72 a minute → 54).
    worker.onRateLimited();
    expect(Object.values(caps(worker)).reduce((sum, cap) => sum + cap, 0)).toBeLessThanOrEqual(0.75 * 180 + 3);
    worker.onRateLimited();
    worker.onRateLimited();
    expect(worker.introspect().effectiveBudgetPerMin).toBe(72);
    expect(caps(worker)).toEqual({ "pool.performance": 20, "pool.ledgers": 8, history: 10, backfill: 10, cohort: 5 });
  });

  it("at 360/min with every consumer saturated, snapshots, sweeps and cohort reads complete within their periods and no cap is exceeded", async () => {
    const budget = budgeter(360);
    const { average, perMinute, finished } = await saturated(budget, 60);

    const snapshots = finished("snapshots", 5 * MINUTE);
    const sweeps = finished("sweep", 15 * MINUTE);
    expect([snapshots.length, sweeps.length]).toEqual([12, 4]);
    // Every snapshot run inside half a minute, every sweep inside three: nothing failed, nothing timed out.
    expect(snapshots.every((run) => run.ms !== null && run.ms <= 30_000 && run.failed === 0)).toBe(true);
    expect(sweeps.every((run) => run.ms !== null && run.ms <= 3 * MINUTE && run.failed === 0)).toBe(true);
    // The cohort loop gets its (scaled) allowance: 25 a minute.
    // (a little under it: its bucket holds one minute, and it waits behind each sweep.)
    expect(average("cohort")).toBeGreaterThan(22);
    expect(average("cohort")).toBeLessThanOrEqual(25.5);

    // Each capped job stays at its scaled cap over the hour…
    expect(average("pool.performance")).toBeLessThanOrEqual(102);
    expect(average("pool.ledgers")).toBeLessThanOrEqual(43);
    expect(average("history")).toBeLessThanOrEqual(52);
    expect(average("backfill")).toBeLessThanOrEqual(52);
    // …and the pool's ledger loop, which ran at 185 against a cap of 100, cannot double its cap in any minute.
    expect(Math.max(...perMinute("pool.ledgers"))).toBeLessThanOrEqual(2 * 42 + 60);
    // The whole process stays inside its budget (the first minute also spends the burst).
    expect(average()).toBeLessThanOrEqual(362);
    expect(Math.max(...perMinute().slice(1))).toBeLessThanOrEqual(360 + 100);
    // Nothing is starved either: the pool still runs, and so does unlabelled work.
    expect(average("pool.performance")).toBeGreaterThan(85);
    expect(average("other")).toBeGreaterThan(5);
  });

  it("held at the 429 floor (72/min) for an hour, the budget goes to snapshots and sweeps first: they need 69 of the 72", async () => {
    const budget = budgeter(360);
    for (let i = 0; i < 3; i++) budget.onRateLimited();
    expect(budget.introspect().effectiveBudgetPerMin).toBe(72);
    // No success is ever reported here, so the rate stays at the floor:
    // harsher than a real backoff, which recovers 36 a minute per 20 answers.
    const { average, finished } = await saturated(budget, 60);

    const snapshots = finished("snapshots", 5 * MINUTE);
    const sweeps = finished("sweep", 15 * MINUTE);
    expect([snapshots.length, sweeps.length]).toEqual([12, 4]);
    // 20 leaders: snapshots 16 a minute, sweeps 53. Every snapshot run completes in its 5 minutes.
    expect(snapshots.every((run) => run.ms !== null && run.ms < 5 * MINUTE && run.failed === 0)).toBe(true);
    // Sweeps complete, none fails or times out; in steady state inside their
    // 15 minutes, with nothing to spare. The first two, which also repay the
    // debt of the 429 itself, run up to two minutes over.
    expect(sweeps.every((run) => run.ms !== null && run.failed === 0 && run.ms < 17 * MINUTE)).toBe(true);
    expect(sweeps.slice(2).every((run) => run.ms! < 15 * MINUTE)).toBe(true);
    expect(average("snapshots")).toBeCloseTo(16, 0);
    expect(average("sweep")).toBeGreaterThan(50);
    // The pool, history and backfill get what is left: next to nothing.
    expect(average("pool.performance") + average("pool.ledgers") + average("history") + average("backfill")).toBeLessThan(6);
    expect(average()).toBeLessThanOrEqual(73);
  });

  it("a real backoff recovers: from the floor, with answers reported, every run is back inside its period at once", async () => {
    const budget = budgeter(360);
    for (let i = 0; i < 3; i++) budget.onRateLimited();
    const { finished, average } = await saturated(budget, 60, { reportSuccess: true });
    expect(budget.introspect().effectiveBudgetPerMin).toBe(360);
    const snapshots = finished("snapshots", 5 * MINUTE);
    // The first run starts in the 429's own debt; from the second on they take seconds.
    expect(snapshots.every((run) => run.ms !== null && run.ms < 5 * MINUTE && run.failed === 0)).toBe(true);
    expect(snapshots.slice(1).every((run) => run.ms! <= 30_000)).toBe(true);
    const sweeps = finished("sweep", 15 * MINUTE);
    expect(sweeps.every((run) => run.ms !== null && run.ms < 15 * MINUTE && run.failed === 0)).toBe(true);
    expect(sweeps.slice(1).every((run) => run.ms! <= 3 * MINUTE)).toBe(true);
    expect(average("cohort")).toBeGreaterThan(20);
  });

  it("a call that waits past its consumer's deadline fails instead of waiting for ever (the 08:35 snapshot run)", async () => {
    const budget = budgeter(360);
    // A cap of 0 stands for a budget that never comes: the call can only wait.
    budget.setConsumerCaps({ snapshots: 0 });
    const outcome = budgetConsumer("snapshots", () => budget.acquire(2), { queueMs: SNAPSHOT_QUEUE_MS }).then(() => "sent", (error: Error) => error);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_QUEUE_MS - 1);
    expect(budget.queued().background).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeInstanceOf(BudgetWaitError);
    expect(budget.queued().background).toBe(0);
    // Without a deadline the same call is still waiting an hour later.
    let waiting = true;
    void budgetConsumer("snapshots", () => budget.acquire(2)).then(() => { waiting = false; }, () => undefined);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(waiting).toBe(true);
    budget.onModuleDestroy();
  });

  it("essential calls go before the pool's however long the pool has waited; a page that joined a capped job is not held by its cap", async () => {
    vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", "20");
    const budget = budgeter(360);
    // Empty the buckets so that everything below queues.
    await budget.acquire(20, "live");
    const order: string[] = [];
    const queue = (label: string, weight: number, rank?: number) => void budgetConsumer(label, () => budget.acquire(weight, "background", rank)).then(() => order.push(label));
    queue("pool.performance", 20, UNRANKED_BASE - 1);
    queue("history", 20, UNRANKED_BASE);
    queue("cohort", 2, ESSENTIAL_RANK.cohort);
    queue("sweep", 20);
    queue("snapshots", 2);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(order).toEqual(["snapshots", "sweep", "cohort", "pool.performance", "history"]);

    // The pool's ledger cap is spent; a page-rank call under the same label still goes at once.
    vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", "100");
    const drained = budgeter(360);
    await budgetConsumer("pool.ledgers", () => drained.acquire(42));
    let page = false;
    let bulk = false;
    void budgetConsumer("pool.ledgers", () => drained.acquire(20, "background", UNRANKED_BASE)).then(() => { bulk = true; }, () => undefined);
    void budgetConsumer("pool.ledgers", () => drained.acquire(20, "background", PAGE_RANK.fills)).then(() => { page = true; });
    // The main bucket refills within seconds; the cap's 20 would take half a minute.
    await vi.advanceTimersByTimeAsync(5_000);
    expect([page, bulk]).toEqual([true, false]);
    budget.onModuleDestroy();
    drained.onModuleDestroy();
  });
});
