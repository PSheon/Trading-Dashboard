// Reading an Activity on the page. Client-safe: depends on nothing server-side.

import type { Activity } from "./progress";

// A run that has not written for this long is probably dead (killed, crashed).
export const STALE_SECONDS = 15 * 60;

export type RunStatus = "running" | "stalled" | "ok" | "failed" | "none";

export function runStatus(a: Activity | null, now: number): RunStatus {
  if (!a) return "none";
  if (a.outcome !== "running") return a.outcome;
  return now - a.updated_at > STALE_SECONDS ? "stalled" : "running";
}
