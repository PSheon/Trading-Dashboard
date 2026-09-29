import { afterEach, expect, it, vi } from "vitest";
import { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
it("removes aborted waiters without spending tokens", async () => {
  vi.useFakeTimers();
  vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", "1");
  const budget = new RequestBudgeterService();
  await budget.acquire(1, "live");
  const abort = new AbortController();
  const waiting = budget.acquire(1, "background", undefined, { signal: abort.signal });
  const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  abort.abort();
  await rejected;
  expect(budget.queued()).toEqual({ live: 0, background: 0 });
  expect(budget.introspect().requestsLastMinute).toBe(1);
});
it("rejects excess queued requests and clears all waiters on shutdown", async () => {
  vi.useFakeTimers();
  vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", "1");
  const budget = new RequestBudgeterService();
  await budget.acquire(1, "live");
  const waiting = Array.from({ length: 1000 }, () => budget.acquire(1).catch(() => "stopped"));
  await expect(budget.acquire(1)).rejects.toThrow(/queue/i);
  budget.onModuleDestroy();
  expect(await Promise.all(waiting)).toEqual(Array(1000).fill("stopped"));
  expect(budget.queued()).toEqual({ live: 0, background: 0 });
});

it("propagates HTTP caller cancellation through the info client's queue", async () => {
  const { withRequestSignal } = await import("../src/runtime/request-context.js");
  const { HyperliquidInfoClient } = await import("../src/hyperliquid/hyperliquid-info.client.js");
  vi.stubEnv("HYPERLIQUID_WEIGHT_BURST", "1");
  const budget = new RequestBudgeterService();
  await budget.acquire(1, "live");
  const abort = new AbortController();
  const client = new HyperliquidInfoClient(budget);
  const waiting = withRequestSignal(abort.signal, () => client.portfolio("0x" + "ab".repeat(20)));
  const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  abort.abort();
  await rejected;
  expect(budget.queued()).toEqual({ live: 0, background: 0 });
  budget.onModuleDestroy();
});

it("keeps explicitly admitted background jobs independent of HTTP cancellation", async () => {
  const { withRequestSignal, currentRequestSignal } = await import("../src/runtime/request-context.js");
  const { BackgroundJobs } = await import("../src/runtime/background-jobs.service.js");
  const jobs = new BackgroundJobs();
  const abort = new AbortController();
  await withRequestSignal(abort.signal, () => jobs.run(async () => {
    expect(currentRequestSignal()).toBeUndefined();
  }));
});
