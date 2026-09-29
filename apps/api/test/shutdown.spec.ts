import { testConfig } from "./config-test-utils.js";
import { expect, it, vi, afterEach } from "vitest";
import { BackgroundJobs } from "../src/runtime/background-jobs.service.js";
import { RulesSeedService } from "../src/rules/rules-seed.service.js";
import type { DrizzleDb } from "../src/db/drizzle.provider.js";

afterEach(() => vi.useRealTimers());
it("stops new work and waits for admitted jobs", async () => {
  const jobs = new BackgroundJobs();
  let finish!: () => void;
  const work = jobs.run(() => new Promise<void>((resolve) => { finish = resolve; }));
  await Promise.resolve();
  const drained = jobs.drain();
  await expect(jobs.run(async () => 1)).rejects.toThrow(/shutting down/);
  finish(); await work;
  expect(await drained).toBe(true);
});
it("bounds drain duration", async () => {
  vi.useFakeTimers();
  const jobs = new BackgroundJobs();
  void jobs.run(() => new Promise(() => {}));
  const drained = jobs.drain(100);
  await vi.advanceTimersByTimeAsync(100);
  expect(await drained).toBe(false);
});
it("cancels seed retries and does not rearm after an in-flight failure", async () => {
  vi.useFakeTimers();
  const seed = new RulesSeedService(testConfig(), {} as DrizzleDb);
  const work = vi.spyOn(seed, "seedDefaultRules").mockRejectedValue(new Error("offline"));
  vi.stubEnv("NODE_ENV", "development");
  try {
    seed.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    seed.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(work).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllEnvs(); }
});

it("closes the database pool only after admitted work finishes", async () => {
  const { DatabaseLifecycle } = await import("../src/db/database-lifecycle.service.js");
  const jobs = new BackgroundJobs();
  let finish!: () => void;
  const work = jobs.run(() => new Promise<void>((resolve) => { finish = resolve; }));
  await Promise.resolve();
  const end = vi.fn(async () => {});
  const lifecycle = new DatabaseLifecycle({ end } as unknown as import("pg").Pool, jobs);
  const closing = lifecycle.onApplicationShutdown();
  expect(end).not.toHaveBeenCalled();
  finish(); await work; await closing;
  expect(end).toHaveBeenCalledTimes(1);
});

it("does not let a checked-out DB connection defeat shutdown's pool deadline", async () => {
  vi.useFakeTimers();
  const { DatabaseLifecycle } = await import("../src/db/database-lifecycle.service.js");
  const lifecycle = new DatabaseLifecycle({ end: () => new Promise(() => {}) } as unknown as import("pg").Pool, new BackgroundJobs());
  const closing = lifecycle.onApplicationShutdown();
  await vi.advanceTimersByTimeAsync(30_000);
  await closing;
});
