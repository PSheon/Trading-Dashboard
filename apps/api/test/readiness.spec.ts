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
