import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { AppConfig } from "../src/config/app-config.js";
import { validateEnvironment } from "../src/config/runtime-config.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import type { DrizzleDb } from "../src/db/drizzle.provider.js";
import { LiveBoundaryError } from "../src/copy/live/wallet-authorization.js";
import { HyperliquidGlobalTransport } from "../src/hyperliquid/hyperliquid-global-transport.js";
import { planHyperliquidQuota, type HyperliquidQuotaState, type HyperliquidRestLane } from "../src/hyperliquid/hyperliquid-global-quota.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { PostgresHyperliquidQuota, type BoundHyperliquidQuota } from "../src/hyperliquid/postgres-hyperliquid-quota.js";
import { budgetConsumer, ESSENTIAL_RANK, PAGE_RANK, RequestBudgeterService, UNRANKED_BASE } from "../src/hyperliquid/request-budgeter.service.js";
import { BackgroundJobs } from "../src/runtime/background-jobs.service.js";
import { SNAPSHOT_QUEUE_MS, SWEEP_QUEUE_MS } from "../src/scheduler/scheduler.service.js";
import { testConfig } from "./config-test-utils.js";

const MINUTE = 60_000;
const DATABASE_URL = "postgres://test@localhost/test";

describe("per-process budgets: the api's and the worker's", () => {
  it("one environment gives the worker its own share (HYPERLIQUID_WORKER_WEIGHT_*), as WORKER_PORT gives it a port", () => {
    const shared = { DATABASE_URL, HYPERLIQUID_WEIGHT_BUDGET_PER_MIN: "480", HYPERLIQUID_WEIGHT_BURST: "200",
      HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN: "360", HYPERLIQUID_WORKER_WEIGHT_BURST: "100" };
    expect(validateEnvironment(shared).hyperliquid).toMatchObject({ budgetPerMin: 480, burst: 200 });
    expect(validateEnvironment({ ...shared, IS_WORKER: "true" }).hyperliquid).toMatchObject({ budgetPerMin: 360, burst: 100 });
    // A deployment that sets each service's own HYPERLIQUID_WEIGHT_* is unchanged.
    expect(validateEnvironment({ DATABASE_URL, IS_WORKER: "true", HYPERLIQUID_WEIGHT_BUDGET_PER_MIN: "360", HYPERLIQUID_WEIGHT_BURST: "100" }).hyperliquid)
      .toMatchObject({ budgetPerMin: 360, burst: 100 });
    expect(() => validateEnvironment({ DATABASE_URL, IS_WORKER: "true", HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN: "1200" })).toThrow();
  });
});

/** Valid list items for the fake provider: what a call returns decides its
 * settled weight (20 + 1 per 20 items), as on Hyperliquid. */
const fills = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({
  coin: "BTC", px: "100", sz: "1", side: "B", time: 1_790_000_000_000 + i, tid: i + 1, startPosition: "0", closedPnl: "0", fee: "0",
  dir: "Open Long", hash: "0x", oid: 1, crossed: true })));
const state = JSON.stringify({ assetPositions: [], marginSummary: { accountValue: "1", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "1" },
  crossMarginSummary: { accountValue: "1", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "1" }, withdrawable: "1", time: 1 });

/**
 * Two processes on one IP, each with its own RequestBudgeterService, info
 * client and global transport, drawing on one shared meter: the accounting
 * of the Postgres DAL (`planHyperliquidQuota`, with each process's list
 * settlements riding on its next charge) kept in memory. Fake timers.
 */
function sharedEgress() {
  let meter: HyperliquidQuotaState = { egressKey: "sim", revision: 1, events: [], updatedAt: Date.now() };
  const exhausted = new Map<string, number>();
  const sent = { total: 0 };
  const spawn = (name: string, budgetPerMin: number, burst: number, caps?: Record<string, number>) => {
    const base = testConfig().value;
    const config = { value: { ...base, hyperliquid: { ...base.hyperliquid, budgetPerMin, burst, startupPaceSeconds: 60 } } } as unknown as AppConfig;
    const budgeter = new RequestBudgeterService(config);
    if (caps) budgeter.setConsumerCaps(caps);
    const settlements = new Map<string, number>();
    const acquireRest: BoundHyperliquidQuota["acquireRest"] = async (weight: number, deadline: number, lane?: HyperliquidRestLane) => {
      const id = randomUUID(), settle = [...settlements].slice(0, 64).map(([sid, units]) => ({ id: sid, units }));
      const plan = planHyperliquidQuota({ now: Date.now(), state: meter, leases: [],
        request: { kind: "rest", id, weight, sendUntil: deadline, ...(lane ? { lane } : {}), ...(settle.length ? { settle } : {}) } });
      meter = plan.state;
      for (const s of settle) settlements.delete(s.id);
      return { assertFresh: () => {}, dispatch: <T>(work: () => T): T => work(), settle: (units: number) => { if (units < weight) settlements.set(id, units); } };
    };
    const quota = new PostgresHyperliquidQuota(new UnitOfWork({} as DrizzleDb));
    vi.spyOn(quota, "bindUnscoped").mockReturnValue({ acquireRest, reserveSocket: vi.fn() });
    const fetcher: typeof fetch = async (_url, init) => {
      sent.total += 1;
      const body = JSON.parse(String(init?.body)) as { type: string; endTime?: number };
      const answers: Record<string, string> = { portfolio: "[]", clearinghouseState: state, spotClearinghouseState: '{"balances":[]}',
        userAbstraction: '"disabled"', delegatorSummary: '{"delegated":"0","undelegated":"0","totalPendingWithdrawal":"0","nPendingWithdrawals":0}' };
      // A list's size is carried in endTime by the callers below.
      return new Response(answers[body.type] ?? lists.get(body.endTime ?? 0) ?? "[]");
    };
    const transport = new HyperliquidGlobalTransport(quota, { egressKey: "sim", ownerId: name }, fetcher, Date.now, (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const info = new HyperliquidInfoClient(config, budgeter, new BackgroundJobs(), transport);
    const call = async (label: string, work: () => Promise<unknown>) => {
      try { await work(); } catch (error) {
        if (error instanceof LiveBoundaryError && error.code === "hyperliquid_quota_exhausted") exhausted.set(label, (exhausted.get(label) ?? 0) + 1);
      }
    };
    return { budgeter, info, call };
  };
  const lists = new Map<number, string>([[30, fills(30)], [100, fills(100)], [300, fills(300)], [1000, fills(1000)], [2000, fills(2000)]]);
  return { spawn, exhausted, sent };
}

describe("one IP, two processes: the worker is not starved by the shared meter", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** The admin's discovery caps on dev (scaled to 75 % of the budget). */
  const CAPS = { "pool.performance": 240, "pool.ledgers": 100, history: 120, backfill: 120, cohort: 150 };
  const A = `0x${"ab".repeat(20)}`;

  /**
   * Ten minutes (after the first, paced one) of the dev worker with every job
   * wanting more than it may have: the pool's two loops, the history job, the
   * backfill, an unlabelled job and the cohort reads always waiting; a fill
   * confirm every 3 s; snapshots of 20 leaders on two dexes every 5 minutes and
   * their sweeps every 15. Beside it the api serves a cold trader page every
   * 2 minutes. Returns the `hyperliquid_quota_exhausted` answers per consumer.
   */
  async function tenMinutes(budgets: { api: [number, number]; worker: [number, number] }, confirmLabel: string | null) {
    const egress = sharedEgress();
    const api = egress.spawn("api", ...budgets.api);
    const worker = egress.spawn("worker", ...budgets.worker, CAPS);
    let stopped = false;
    const loop = (label: string, lanes: number, work: () => Promise<unknown>) => {
      for (let lane = 0; lane < lanes; lane++) {
        const run = async () => { while (!stopped) await worker.call(label, work); };
        void (label === "other" ? run() : budgetConsumer(label, run));
      }
    };
    loop("pool.performance", 4, () => worker.info.portfolio(A, "background", UNRANKED_BASE - 1));
    loop("pool.ledgers", 2, () => worker.info.userFillsByTime(A, 0, 300, "background", UNRANKED_BASE));
    loop("history", 2, () => worker.info.userFillsByTime(A, 0, 2000, "background", UNRANKED_BASE));
    loop("backfill", 1, () => worker.info.userFillsByTime(A, 0, 1000, "background"));
    loop("other", 2, () => worker.info.portfolio(A, "background"));
    loop("cohort", 4, () => worker.info.clearinghouseState(A, undefined, "background", ESSENTIAL_RANK.cohort));
    const timers: ReturnType<typeof setInterval>[] = [];
    const every = (ms: number, work: () => void) => { work(); timers.push(setInterval(work, ms)); };
    const confirm = () => worker.call("confirm", () => worker.info.userFillsByTime(A, 0, 30, "background"));
    every(3_000, () => void (confirmLabel ? budgetConsumer(confirmLabel, confirm) : confirm()));
    every(5 * MINUTE, () => void budgetConsumer("snapshots", () => Promise.all(Array.from({ length: 40 }, () =>
      worker.call("snapshots", () => worker.info.clearinghouseState(A, undefined, "background")))), { queueMs: SNAPSHOT_QUEUE_MS }));
    every(15 * MINUTE, () => void budgetConsumer("sweep", () => Promise.all(Array.from({ length: 40 }, () =>
      worker.call("sweep", () => worker.info.userFillsByTime(A, 0, 100, "background")))), { queueMs: SWEEP_QUEUE_MS }));
    every(2 * MINUTE, () => void Promise.all([
      api.call("page", () => api.info.spotClearinghouseState(A, "background", PAGE_RANK.profile)),
      api.call("page", () => api.info.userAbstraction(A, "background", PAGE_RANK.profile)),
      api.call("page", () => api.info.delegatorSummary(A, "background", PAGE_RANK.profile)),
      api.call("page", () => api.info.portfolio(A, "background", PAGE_RANK.portfolio)),
      api.call("page", () => api.info.userFillsByTime(A, 0, 2000, "background", PAGE_RANK.fills)),
    ]));
    // The first minute is the paced start; count the ten after it.
    await vi.advanceTimersByTimeAsync(MINUTE);
    egress.exhausted.clear();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    stopped = true;
    timers.forEach(clearInterval);
    api.budgeter.onModuleDestroy(); worker.budgeter.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(20_000);
    const result = Object.fromEntries(egress.exhausted);
    return { byConsumer: result, total: Object.values(result).reduce((sum, n) => sum + n, 0), requests: egress.sent.total };
  }

  it("before: both processes at 840 a minute against a background lane of 840, confirms failing at once", async () => {
    const before = await tenMinutes({ api: [840, 200], worker: [840, 200] }, null);
    console.log(`shared meter, before (api 840/200, worker 840/200): ${before.total} exhausted in 10 min`, before.byConsumer);
    expect(before.total).toBeGreaterThan(0);
  }, 120_000);

  it("after: the budgets add up (api 480/200, worker 360/100) and confirms wait for room: nothing is refused", async () => {
    const after = await tenMinutes({ api: [480, 200], worker: [360, 100] }, "confirm");
    console.log(`shared meter, after (api 480/200, worker 360/100): ${after.total} exhausted in 10 min`, after.byConsumer);
    expect(after.byConsumer).toEqual({});
  }, 120_000);
});
