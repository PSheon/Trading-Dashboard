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

/** A span of history the public node archive certifies for one address:
 * every fill with `from <= time < through` is stored locally. */
export interface ArchiveSpan { from: number; through: number }

/** Hourly archive files rotate on the node's clock, not on block time, so a
 * fill near an hour boundary may sit in the neighbouring file. A span is
 * therefore certified only this far inside the hours actually ingested;
 * REST re-reads the margins (duplicates collapse on the tid key). */
export const ARCHIVE_BOUNDARY_MARGIN_MS = 5 * 60_000;

/** The certified span of ingested hours `[coveredFrom, coveredThrough)`;
 * null when it is too short to certify anything. */
export function certifiedSpan(coveredFrom: Date | null, coveredThrough: Date | null): ArchiveSpan | null {
  if (!coveredFrom || !coveredThrough) return null;
  const from = coveredFrom.getTime() + ARCHIVE_BOUNDARY_MARGIN_MS;
  const through = coveredThrough.getTime() - ARCHIVE_BOUNDARY_MARGIN_MS;
  return through > from ? { from, through } : null;
}

/**
 * The next REST range of a source, skipping what the archive certifies:
 * a cursor inside the span jumps to its end without a request, and a
 * cursor before it reads only up to the span. `end` is inclusive.
 * The returned checkpoint carries the jump; it is persisted with the page.
 */
export function planRange(checkpoint: HistoryCheckpoint, source: HistorySource, span: ArchiveSpan | null): { checkpoint: HistoryCheckpoint; start: number; end: number } | { checkpoint: HistoryCheckpoint; start: null; end: null } {
  let current = checkpoint.sources[source];
  if (current.status !== "pending") throw new Error("History source is not pending");
  let next = checkpoint;
  if (span && current.cursor >= span.from && current.cursor < span.through) {
    // Archive rows cover [cursor, through): continue from its end.
    const done = span.through > checkpoint.until;
    current = done
      ? { cursor: checkpoint.until, through: checkpoint.until, status: "complete" }
      : { cursor: span.through, through: span.through - 1, status: "pending" };
    next = { ...checkpoint, sources: { ...checkpoint.sources, [source]: current } };
    if (done) return { checkpoint: next, start: null, end: null };
  }
  const end = span && current.cursor < span.from ? Math.min(checkpoint.until, span.from - 1) : checkpoint.until;
  return { checkpoint: next, start: current.cursor, end };
}

/** Inclusive overlap certifies the boundary millisecond only on a short
 * page. A full page cannot move past an unresolved timestamp. `end` is the
 * request's inclusive upper bound when it stopped short of `until` (the
 * archive covers what follows): a short page then completes only up to it. */
export function advanceCheckpoint(checkpoint: HistoryCheckpoint, source: HistorySource, fills: HlUserFill[], end = checkpoint.until): HistoryCheckpoint {
  const current = checkpoint.sources[source];
  if (current.status !== "pending") throw new Error("History source is not pending");
  if (end > checkpoint.until) throw new Error("History range exceeds the checkpoint");
  if (fills.some(f => !Number.isSafeInteger(f.time) || !Number.isSafeInteger(f.tid) || f.time < current.cursor || f.time > end)) {
    throw new Error("Fill outside history request bounds");
  }
  const full = fills.length >= FILL_PAGE;
  const last = fills.reduce((max, f) => Math.max(max, f.time), current.cursor);
  const blocked = full && last <= current.cursor;
  const next: SourceCheckpoint = full
    ? { cursor: last, through: blocked ? current.through : last - 1, status: blocked ? "blocked" : "pending" }
    : end < checkpoint.until
      ? { cursor: end + 1, through: end, status: "pending" }
      : { cursor: checkpoint.until, through: checkpoint.until, status: "complete" };
  return { ...checkpoint, sources: { ...checkpoint.sources, [source]: next }, reason: blocked ? "timestamp_saturated" : checkpoint.reason };
}
export function completeCheckpoint(checkpoint: HistoryCheckpoint): boolean {
  return Object.values(checkpoint.sources).every(s => s.status === "complete");
}
