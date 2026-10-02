import { expect, it, vi } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import type { Pool } from "pg";
import { ReadinessController } from "../src/api/health/readiness.controller.js";
import { BackgroundJobs } from "../src/runtime/background-jobs.service.js";

it("is ready only when the database probe succeeds and shutdown has not started", async () => {
  const jobs = new BackgroundJobs();
  const query = vi.fn(async () => ({}));
  const ready = new ReadinessController({ query } as unknown as Pool, jobs);
  expect(await ready.ready()).toEqual({ ready: true });
  jobs.stop();
  await expect(ready.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect(query).toHaveBeenCalledTimes(1);
});
it("returns 503 without exposing a connection failure", async () => {
  const query = vi.fn(async () => { throw new Error("postgres://secret:password@host"); });
  const ready = new ReadinessController({ query } as unknown as Pool, new BackgroundJobs());
  const error = await ready.ready().catch((error: ServiceUnavailableException) => error);
  expect(error).toBeInstanceOf(ServiceUnavailableException);
  expect((error as ServiceUnavailableException).getResponse()).toEqual({ ready: false });
});
it("probes the database at most once a second however often it is asked", async () => {
  vi.useFakeTimers();
  try {
    let release!: () => void;
    const query = vi.fn(() => new Promise((resolve) => { release = () => resolve({}); }));
    const ready = new ReadinessController({ query } as unknown as Pool, new BackgroundJobs());
    // A burst while the probe runs shares it …
    const burst = Array.from({ length: 200 }, () => ready.ready());
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(1);
    release();
    expect(await Promise.all(burst)).toEqual(Array(200).fill({ ready: true }));
    // … and its answer serves the next second.
    await ready.ready();
    await vi.advanceTimersByTimeAsync(999);
    await ready.ready();
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const next = ready.ready();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await next;
    expect(query).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
it("caches a failed probe for the same second, and still reports shutdown at once", async () => {
  vi.useFakeTimers();
  try {
    const jobs = new BackgroundJobs();
    const query = vi.fn(async () => { throw new Error("down"); });
    const ready = new ReadinessController({ query } as unknown as Pool, jobs);
    await expect(ready.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(ready.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockResolvedValue({} as never);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await ready.ready()).toEqual({ ready: true });
    jobs.stop();
    await expect(ready.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(query).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
it("shares one heartbeat per second between every /health caller", async () => {
  vi.useFakeTimers();
  try {
    const { HealthController } = await import("../src/api/health/health.controller.js");
    const heartbeat = vi.fn(async () => ({ feedConnected: true, now: new Date() }));
    const controller = new HealthController({ heartbeat } as never);
    await Promise.all(Array.from({ length: 100 }, () => controller.heartbeat()));
    expect(heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await controller.heartbeat();
    expect(heartbeat).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
