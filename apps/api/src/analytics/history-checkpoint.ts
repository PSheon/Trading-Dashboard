import type { HlUserFill } from "../hyperliquid/types.js";
import { FILL_PAGE } from "./fill-history.js";

export type HistorySource = "regular" | "twap";
export interface SourceCheckpoint {
  cursor: number;
  through: number | null;
  status: "pending" | "complete" | "blocked";
}
export interface HistoryCheckpoint {
  until: number;
  sources: Record<HistorySource, SourceCheckpoint>;
  reason: "timestamp_saturated" | null;
}
export function initialCheckpoint(until: number, from = 0): HistoryCheckpoint {
  const source = (): SourceCheckpoint => ({ cursor: from, through: from > 0 ? from : null, status: "pending" });
  return { until, sources: { regular: source(), twap: source() }, reason: null };
}

/** Inclusive overlap certifies the boundary millisecond only on a short
 * page. A full page cannot move past an unresolved timestamp. */
export function advanceCheckpoint(checkpoint: HistoryCheckpoint, source: HistorySource, fills: HlUserFill[]): HistoryCheckpoint {
  const current = checkpoint.sources[source];
  if (current.status !== "pending") throw new Error("History source is not pending");
  if (fills.some(f => !Number.isSafeInteger(f.time) || !Number.isSafeInteger(f.tid) || f.time < current.cursor || f.time > checkpoint.until)) {
    throw new Error("Fill outside history request bounds");
  }
  const full = fills.length >= FILL_PAGE;
  const last = fills.reduce((max, f) => Math.max(max, f.time), current.cursor);
  const blocked = full && last <= current.cursor;
  const next: SourceCheckpoint = full
    ? { cursor: last, through: blocked ? current.through : last - 1, status: blocked ? "blocked" : "pending" }
    : { cursor: checkpoint.until, through: checkpoint.until, status: "complete" };
  return { ...checkpoint, sources: { ...checkpoint.sources, [source]: next }, reason: blocked ? "timestamp_saturated" : checkpoint.reason };
}
export function completeCheckpoint(checkpoint: HistoryCheckpoint): boolean {
  return Object.values(checkpoint.sources).every(s => s.status === "complete");
}
