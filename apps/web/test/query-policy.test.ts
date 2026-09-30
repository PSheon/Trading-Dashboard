import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api";
import { busyRetry, computingRetry, defaultRetry } from "../src/lib/query-policy";

describe("query retry policy", () => {
  it.each([400, 401, 403, 404, 409, 422, 429])("never retries HTTP %i in any query policy", (status) => {
    for (const policy of [defaultRetry, busyRetry, computingRetry]) {
      expect(policy.retry(0, new ApiError(status, "Rejected"))).toBe(false);
    }
  });
  it("does not retry cancelled requests", () => {
    for (const policy of [defaultRetry, busyRetry, computingRetry]) {
      expect(policy.retry(0, new DOMException("Cancelled", "AbortError"))).toBe(false);
    }
  });
  it("retains bounded busy recovery and Retry-After", () => {
    const busy = new ApiError(503, "Computing", { code: "busy" }, 8000);
    expect(busyRetry.retry(11, busy)).toBe(true);
    expect(busyRetry.retry(12, busy)).toBe(false);
    expect(computingRetry.retry(119, busy)).toBe(true);
    expect(computingRetry.retry(120, busy)).toBe(false);
    expect(busyRetry.retryDelay(0, busy)).toBe(8000);
    expect(busyRetry.retryDelay(0, new ApiError(503, "Busy", { code: "busy" }, 60000))).toBe(30000);
  });
  it("uses one retry for ordinary transient failures across all queries", () => {
    for (const policy of [defaultRetry, busyRetry, computingRetry]) {
      expect(policy.retry(0, new Error("Network unavailable"))).toBe(true);
      expect(policy.retry(1, new ApiError(500, "Unavailable"))).toBe(false);
    }
  });
});
