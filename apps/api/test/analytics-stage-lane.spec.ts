import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { readRecentHistory } from "../src/analytics/fill-history.js";
import type { AppConfig } from "../src/config/app-config.js";
import { validateEnvironment } from "../src/config/runtime-config.js";
import { UnitOfWork } from "../src/db/unit-of-work.js";
import type { DrizzleDb } from "../src/db/drizzle.provider.js";
import { HyperliquidGlobalTransport } from "../src/hyperliquid/hyperliquid-global-transport.js";
import { HYPERLIQUID_REST_CAP, planHyperliquidQuota, type HyperliquidQuotaState, type HyperliquidRestLane } from "../src/hyperliquid/hyperliquid-global-quota.js";
import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { PostgresHyperliquidQuota, type BoundHyperliquidQuota } from "../src/hyperliquid/postgres-hyperliquid-quota.js";
import { budgetConsumer, PAGE_RANK, RequestBudgeterService, UNRANKED_BASE } from "../src/hyperliquid/request-budgeter.service.js";
import type { HlUserFill } from "../src/hyperliquid/types.js";
import { BackgroundJobs } from "../src/runtime/background-jobs.service.js";
import { withRequestSignal } from "../src/runtime/request-context.js";
import { COLD_FILL_CALLS, COLD_TARGET_FILLS, LOOKBACK_MS } from "../src/traders/trade-analytics.service.js";
import { isBusyError } from "../src/traders/traders.controller.js";
import { testConfig } from "./config-test-utils.js";
import { offlineGlobalTransport } from "./hyperliquid-quota-test-utils.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** Stage (mainnet), 2026-10-07: the api's and the worker's Hyperliquid
 * variables, as set on Railway. */
const STAGE = {
  api: { HYPERLIQUID_NETWORK: "mainnet", HYPERLIQUID_WEIGHT_BUDGET_PER_MIN: "480", HYPERLIQUID_WEIGHT_BURST: "720", HYPERLIQUID_BACKGROUND_REST_CAP: "400" },
  worker: { IS_WORKER: "true", HYPERLIQUID_NETWORK: "mainnet", HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN: "360", HYPERLIQUID_WORKER_WEIGHT_BURST: "840",
    HYPERLIQUID_BACKGROUND_REST_CAP: "400", HYPERLIQUID_WEIGHT_BUDGET_PER_MIN: "360", HYPERLIQUID_WEIGHT_BURST: "100" },
};

/** A dense trader: one fill a second, so every `userFillsByTime` page of a
 * cold read is full (2,000 fills, 120 weight, nothing to settle). */
function denseFills(start: number, end: number): HlUserFill[] {
  const first = Math.ceil(start / SECOND) * SECOND;
  const out: HlUserFill[] = [];
  for (let time = first; time <= end && out.length < 2000; time += SECOND) {
    out.push({ coin: "BTC", px: "100", sz: "1", side: "B", time, tid: time / SECOND, startPosition: "0", closedPnl: "0", fee: "0",
      dir: "Open Long", hash: "0x", oid: 1, crossed: true } as HlUserFill);
  }
  return out;
}

/**
 * The api and the worker on one IP, each with its own budgeter, info client
 * and global transport, charging one shared meter with the Postgres DAL's
 * accounting (`planHyperliquidQuota`, list settlements riding on the
 * process's next charge) and Stage's background cap. Fake timers.
 */
function stage() {
  let meter: HyperliquidQuotaState = { egressKey: "stage", revision: 1, events: [], updatedAt: Date.now() };
  let peak = 0;
  const spawn = (name: string, env: Record<string, string>) => {
    const hyperliquid = { ...validateEnvironment({ DATABASE_URL: "postgres://test@localhost/test", ...env }).hyperliquid, startupPaceSeconds: 0 };
    const base = testConfig().value;
    const config = { value: { ...base, hyperliquid } } as unknown as AppConfig;
    const budgeter = new RequestBudgeterService(config);
    const settlements = new Map<string, number>();
    const acquireRest: BoundHyperliquidQuota["acquireRest"] = async (weight: number, deadline: number, lane?: HyperliquidRestLane) => {
      const id = randomUUID(), settle = [...settlements].slice(0, 64).map(([sid, units]) => ({ id: sid, units }));
      const plan = planHyperliquidQuota({ now: Date.now(), state: meter, leases: [], backgroundCap: hyperliquid.backgroundRestCap,
        request: { kind: "rest", id, weight, sendUntil: deadline, ...(lane ? { lane } : {}), ...(settle.length ? { settle } : {}) } });
      meter = plan.state;
      peak = Math.max(peak, meter.events.filter((e) => e.kind === "rest").reduce((sum, e) => sum + e.units, 0));
      for (const s of settle) settlements.delete(s.id);
      return { assertFresh: () => {}, dispatch: <T>(work: () => T): T => work(), settle: (units: number) => { if (units < weight) settlements.set(id, units); } };
    };
    const quota = new PostgresHyperliquidQuota(new UnitOfWork({} as DrizzleDb));
    vi.spyOn(quota, "bindUnscoped").mockReturnValue({ acquireRest, reserveSocket: vi.fn() });
    const fetcher: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { type: string; startTime?: number; endTime?: number };
      if (body.type === "userFillsByTime") return Response.json(denseFills(body.startTime!, body.endTime ?? Date.now()));
      if (body.type === "perpDexs") return Response.json([null]);
      return Response.json({ assetPositions: [], marginSummary: { accountValue: "1", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "1" },
        crossMarginSummary: { accountValue: "1", totalMarginUsed: "0", totalNtlPos: "0", totalRawUsd: "1" }, withdrawable: "1", time: Date.now() });
    };
    const transport = new HyperliquidGlobalTransport(quota, { egressKey: "stage", ownerId: name }, fetcher, Date.now, (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const jobs = new BackgroundJobs();
    return { budgeter, jobs, info: new HyperliquidInfoClient(config, budgeter, jobs, transport), backgroundCap: hyperliquid.backgroundRestCap };
  };
  return { spawn, peak: () => peak };
}

/** A cold dense trader's fill history as the analytics job reads it
 * (`coldHyperliquid`): its latest page from the page's cache, then
 * `userFillsByTime` windows back to `COLD_TARGET_FILLS`, in the analytics
 * lane at `PAGE_RANK.analytics`. */
function coldRead(info: HyperliquidInfoClient, address: string) {
  const now = Date.now();
  const source = {
    latest: async () => denseFills(now - 2000 * SECOND, now),
    range: (start: number, end: number) => info.userFillsByTime(address, start, end, "background", PAGE_RANK.analytics),
  };
  return budgetConsumer("analytics", () => readRecentHistory(source, { now, lookbackStart: now - LOOKBACK_MS, target: COLD_TARGET_FILLS, maxCalls: COLD_FILL_CALLS }));
}

describe("Stage (mainnet) env: a cold dense trader's analytics complete", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("every page waits out the charges ahead of it in the 400 background lane instead of failing the computation (503 busy for hours)", async () => {
    const egress = stage();
    const api = egress.spawn("api", STAGE.api);
    const worker = egress.spawn("worker", STAGE.worker);
    expect(api.backgroundCap).toBe(400);
    // What holds the shared window on Stage besides background work (sampled
    // 2026-10-07 06:22: 220–284 with no list in it): the live lane's
    // clearinghouseState every second and a 20-weight read every 10 s.
    const A = `0x${"4a".repeat(20)}`;
    const timers = [
      setInterval(() => void worker.info.clearinghouseState(A, undefined, "live").catch(() => undefined), SECOND),
      setInterval(() => void worker.info.perpDexs("live").catch(() => undefined), 10 * SECOND),
      // The worker's history job: one fail-fast background page a minute.
      setInterval(() => void budgetConsumer("history", () => worker.info.userFillsByTime(A, 0, 1, "background", UNRANKED_BASE)).catch(() => undefined), MINUTE),
    ];
    await vi.advanceTimersByTimeAsync(MINUTE);

    // Two cold traders opened together (MAX_CONCURRENT = 2).
    const outcomes = [`0x${"e7".repeat(20)}`, `0x${"4b".repeat(20)}`].map((address) => {
      const outcome: { fills?: number; error?: unknown } = {};
      void api.jobs.run(() => coldRead(api.info, address)).then((history) => { outcome.fills = history.fills.length; }, (error: unknown) => { outcome.error = error; });
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    timers.forEach(clearInterval);
    api.budgeter.onModuleDestroy(); worker.budgeter.onModuleDestroy();

    for (const outcome of outcomes) {
      // Before: the second full page waited at most 40 s for room the first
      // one held for 65 s, and failed the computation with
      // hyperliquid_quota_exhausted (a busy error: every retry of the page
      // answered 503 and started over).
      if (outcome.error) expect.fail(`analytics failed${isBusyError(outcome.error) ? " (503 busy)" : ""}: ${(outcome.error as Error).message}`);
      expect(outcome.fills).toBeGreaterThanOrEqual(COLD_TARGET_FILLS);
    }
    // Never past Hyperliquid's per-IP limit.
    expect(egress.peak()).toBeLessThanOrEqual(HYPERLIQUID_REST_CAP);
  }, 60_000);
});

describe("analytics reads of one process go one at a time, in arrival order", () => {
  it("a read waits for the ones before it; one that leaves the queue keeps the others' order; other work never waits", async () => {
    const order: string[] = [];
    const answers = new Map<string, () => void>();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const { user } = JSON.parse(String(init?.body)) as { user: string };
      if (user.startsWith("0xdd")) return Response.json([]);
      order.push(user.slice(2, 4));
      await new Promise<void>((resolve) => answers.set(user.slice(2, 4), resolve));
      return Response.json([]);
    });
    const q = offlineGlobalTransport(fetcher);
    const budget = { acquire: vi.fn(async () => {}), adjust: vi.fn(), onSuccess: vi.fn(), onRateLimited: vi.fn() };
    const info = new HyperliquidInfoClient(testConfig(), budget as unknown as RequestBudgeterService, undefined, q.transport);
    const read = (who: string, signal?: AbortSignal) => {
      const work = () => budgetConsumer("analytics", () => info.userFillsByTime(`0x${who.repeat(20)}`, 0, 1, "background", PAGE_RANK.analytics));
      const promise = signal ? withRequestSignal(signal, work) : work();
      promise.catch(() => undefined);
      return promise;
    };
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const leaving = new AbortController();
    const first = read("aa"), second = read("bb", leaving.signal), third = read("cc");
    // Work outside the analytics lane is not queued behind it.
    expect(await info.userFillsByTime(`0x${"dd".repeat(20)}`, 0, 1, "background", UNRANKED_BASE)).toEqual([]);
    await flush();
    expect(order).toEqual(["aa"]);
    leaving.abort();
    await expect(second).rejects.toThrow();
    answers.get("aa")!();
    await first;
    await flush();
    expect(order).toEqual(["aa", "cc"]);
    answers.get("cc")!();
    await third;
    // The one that left took no budget and sent nothing.
    expect(budget.acquire).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
