import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { currentRequestId } from "./request-context.js";

/** The request ids the api accepts from a caller (see `responseMeta`). */
export const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * The key the api shows the worker for `/health/monitor` (settings,
 * switches, request budget, heartbeat). Derived from DATABASE_URL, which
 * both services already hold and which grants far more than this page: no
 * extra variable to set or rotate, and nothing else on the private network
 * (or a worker port published by mistake) can read the telemetry.
 */
export function workerMonitorKey(databaseUrl: string): string {
  return createHmac("sha256", databaseUrl).update("orbie:worker-monitor:v1").digest("hex");
}

/** Whether an Authorization header carries `key` (constant time). */
export function hasWorkerMonitorKey(authorization: string | undefined, key: string): boolean {
  const match = /^Bearer (\S+)$/.exec(authorization ?? "");
  if (!match) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(match[1]!), digest(key));
}

/** Headers for a call from the api to the worker: the current request's id,
 * so the worker's log lines for it can be matched to the api's. */
export function workerCallHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const requestId = currentRequestId();
  return { ...extra, ...(requestId && REQUEST_ID_PATTERN.test(requestId) ? { "x-request-id": requestId } : {}) };
}
