import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api";
import { busyRetry, computingRetry, defaultRetry, traderRetry } from "../src/lib/query-policy";

describe("query retry policy", () => {
  it.each([400, 401, 403, 404, 409, 422, 429])("never retries HTTP %i in any query policy", (status) => {
    for (const policy of [defaultRetry, busyRetry, computingRetry, traderRetry]) {
      expect(policy.retry(0, new ApiError(status, "Rejected"))).toBe(false);
    }
  });
  it("does not retry cancelled requests", () => {
    for (const policy of [defaultRetry, busyRetry, computingRetry, traderRetry]) {
      expect(policy.retry(0, new DOMException("Cancelled", "AbortError"))).toBe(false);
    }
  });
  it("retains bounded busy recovery and Retry-After", () => {
    const busy = new ApiError(503, "Computing", { code: "busy" }, 8000);
    expect(busyRetry.retry(11, busy)).toBe(true);
    expect(busyRetry.retry(12, busy)).toBe(false);
    expect(computingRetry.retry(29, busy)).toBe(true);
    expect(computingRetry.retry(30, busy)).toBe(false);
    expect(busyRetry.retryDelay(0, busy)).toBe(8000);
    expect(busyRetry.retryDelay(0, new ApiError(503, "Busy", { code: "busy" }, 60000))).toBe(30000);
  });
  it("uses one retry for ordinary transient failures outside the trader page", () => {
    for (const policy of [defaultRetry, busyRetry]) {
      expect(policy.retry(0, new Error("Network unavailable"))).toBe(true);
      expect(policy.retry(1, new ApiError(500, "Unavailable"))).toBe(false);
    }
  });
  it("trader page: three silent retries of any 503, 5xx or network failure, as CopyDog", () => {
    for (const error of [new ApiError(503, "Busy", { code: "busy" }), new ApiError(503, "Service Unavailable"), new ApiError(504, "Gateway Timeout"), new Error("Failed to fetch")]) {
      expect([0, 1, 2, 3].map((count) => traderRetry.retry(count, error))).toEqual([true, true, true, false]);
    }
    // Analytics: the same three for a plain failure, the long wait only while the api says busy.
    expect([2, 3].map((count) => computingRetry.retry(count, new ApiError(500, "Unavailable")))).toEqual([true, false]);
  });
  it("trader page: a 503 backs off 5 s, 10 s, 15 s, 20 s and never undercuts Retry-After", () => {
    const delays = (error: Error) => [0, 1, 2, 3, 9].map((attempt) => traderRetry.retryDelay(attempt, error));
    expect(delays(new ApiError(503, "Service Unavailable"))).toEqual([5000, 10000, 15000, 20000, 20000]);
    expect(delays(new ApiError(503, "Busy", { code: "busy" }, 5000))).toEqual([5000, 10000, 15000, 20000, 20000]);
    expect(delays(new ApiError(503, "Busy", { code: "busy" }, 12000))).toEqual([12000, 12000, 15000, 20000, 20000]);
    expect(delays(new ApiError(503, "Busy", { code: "busy" }, 600000))).toEqual([30000, 30000, 30000, 30000, 30000]);
    expect(delays(new Error("Failed to fetch"))).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(computingRetry.retryDelay(1, new ApiError(503, "Busy", { code: "busy" }, 5000))).toBe(10000);
  });
});
