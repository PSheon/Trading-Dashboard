import type { HlUserFill } from "../hyperliquid/types.js";

/** Hyperliquid's per-call cap on fill lists (`userFills`,
 * `userFillsByTime`, TWAP slices). */
export const FILL_PAGE = 2000;

/**
 * One fill list: its latest page (`userFills` / `userTwapSliceFills`,
 * newest ≤ 2,000) and time ranges (`…ByTime`: the *earliest* ≤ 2,000 fills
 * at or after `start`, up to `end` inclusive, oldest first; verified live
 * 2026-09-29).
 */
export interface FillSource {
  latest(): Promise<HlUserFill[]>;
  range(start: number, end: number): Promise<HlUserFill[]>;
}

export interface HistoryOptions {
  now: number;
  /** Never read before this. */
  lookbackStart: number;
  /** Stop once this many fills are in (the newest ones). */
  target: number;
  /** Stop after this many `range` calls. */
  maxCalls: number;
  /** Past `target`, keep reading until this holds too (e.g. enough closed
   * trades for the statistics to mean something). */
  enough?: (fills: HlUserFill[]) => boolean;
}

export interface History {
  /** Deduplicated by tid; any order. */
  fills: HlUserFill[];
  /** Certified lower boundary of available history. Preserve it even if
   * a truncated result has no fills, so other streams cannot cross its gap.
   * It may be now + 1 when no interval was certified; null = complete empty. */
  from: number | null;
  /** Stopped before reaching `lookbackStart` (target or call cap). */
  truncated: boolean;
  calls: number;
}

/**
 * The newest fills of one list, read backwards from now: the latest page,
 * then windows ending where the covered span begins. `…ByTime` answers a
 * window with its *earliest* 2,000 fills, so a full answer is continued
 * forward inside the window until it is complete; the next window's
 * length is sized from the density just seen (aiming at one page), and
 * grows 8× across empty stretches. `target` and `lookbackStart` bound our
 * work. Upstream may retain less: its docs promise only the latest 10,000
 * fills, even though earlier samples returned more. Completing pagination
 * proves coverage of available responses, not the account's lifetime.
 */
export async function readRecentHistory(source: FillSource, options: HistoryOptions): Promise<History> {
  const byTid = new Map<number, HlUserFill>();
  const add = (batch: HlUserFill[]) => {
    for (const f of batch) {
      if (f.time >= options.lookbackStart && f.time <= options.now) byTid.set(f.tid, f);
    }
  };
  const latest = await source.latest();
  add(latest);
  let calls = 0;
  if (latest.length < FILL_PAGE) {
    // The whole list fits in one page.
    const kept = [...byTid.values()];
    const oldest = kept.length > 0 ? Math.min(...kept.map((f) => f.time)) : null;
    return { fills: [...byTid.values()], from: oldest, truncated: false, calls };
  }

  // The oldest millisecond of a full latest page may itself be split.
  // Only the suffix strictly after it is certified until range reads cover it.
  let end = Math.min(options.now + 1, Math.min(...latest.map((f) => f.time)) + 1);
  // The latest page's own span holds one page of fills: the first window
  // aims at the same (not at "now − end", which counts idle time since the
  // last fill and made a first window of a bursty trader tens of pages).
  let span = Math.max(60_000, Math.max(...latest.map((f) => f.time)) - end);
  let reachedStart = false;
  while (calls < options.maxCalls) {
    if (end <= options.lookbackStart) {
      reachedStart = true;
      break;
    }
    if (byTid.size >= options.target && (options.enough?.([...byTid.values()]) ?? true)) break;
    // Whole milliseconds: Hyperliquid answers 422 to a fractional time.
    const start = Math.max(options.lookbackStart, Math.floor(end - span));
    let cursor = start;
    let inWindow = 0;
    let complete = false;
    while (calls < options.maxCalls) {
      const batch = await source.range(cursor, end);
      calls += 1;
      add(batch);
      inWindow += batch.length;
      if (batch.length < FILL_PAGE) {
        complete = true;
        break;
      }
      const last = batch[batch.length - 1].time;
      // A full page ending exactly at `end` is not proof of completion:
      // reread its final millisecond as well. A saturated millisecond stalls
      // conservatively instead of claiming that a partial page is complete.
      // Inclusive: fills sharing `last` may straddle the page boundary.
      if (last <= cursor) break;
      cursor = last;
    }
    if (!complete) break;
    const length = end - start;
    // Aim at 90% of a page, so a window rarely needs a second call.
    span = inWindow === 0 ? length * 8 : Math.min(length * 8, Math.max(60_000, (length * FILL_PAGE * 0.9) / inWindow));
    end = start;
  }
  if (end <= options.lookbackStart) reachedStart = true;
  const fills = [...byTid.values()];
  // Complete from `end` on. Fills before it came from a window that
  // wasn't finished; they are dropped so the span has no holes.
  const kept = fills.filter((f) => f.time >= end);
  return {
    fills: kept,
    from: reachedStart ? (kept.length > 0 ? Math.min(...kept.map((f) => f.time)) : null) : end,
    truncated: !reachedStart,
    calls,
  };
}

/** Reads a list forward from `start` (inclusive) until a short page or
 * `maxCalls`. `complete` is false when it stopped at the cap. */
export async function readForward(
  range: (start: number) => Promise<HlUserFill[]>,
  start: number,
  maxCalls: number,
): Promise<{ fills: HlUserFill[]; calls: number; complete: boolean }> {
  const byTid = new Map<number, HlUserFill>();
  let cursor = start;
  let calls = 0;
  while (calls < maxCalls) {
    const batch = await range(cursor);
    calls += 1;
    for (const f of batch) byTid.set(f.tid, f);
    if (batch.length < FILL_PAGE) return { fills: [...byTid.values()], calls, complete: true };
    const last = batch[batch.length - 1].time;
    if (last <= cursor) return { fills: [...byTid.values()], calls, complete: false };
    cursor = last;
  }
  return { fills: [...byTid.values()], calls, complete: false };
}
