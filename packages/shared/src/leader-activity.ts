import type { LeaderActivityReason, LeaderCopyActivity } from "./schema/zod.js";

/**
 * How active a leader may be for a live copy to keep up. The copy wallet's
 * Hyperliquid lane is 300 weight/min (burst 900); one copy order costs ~44
 * weight plus ~21 per source read, so a few orders a minute is the most a
 * copy can follow. A mainnet vault at ~150 fills/min across 60+ coins
 * failed every copy order (2026-10-11).
 */
export const LEADER_ACTIVITY_WINDOW_MS = 24 * 3_600_000;
export const MAX_LEADER_ORDERS_PER_DAY = 300;
export const MAX_LEADER_ORDERS_PER_MINUTE = 6;
const MINUTE_MS = 60_000;

export interface LeaderActivityFill { time: number; oid: number | string; coin: string }
export interface LeaderActivity {
  /** Distinct orders with a fill in the window. */
  orders: number;
  /** Most orders whose first fill falls within any 60 s. */
  peakPerMinute: number;
  /** The read was a full page (Hyperliquid answers at most 2,000 rows): at
   * least this much activity, likely more. */
  saturated: boolean;
}

/** Orders (distinct oids, one order's partial fills count once) of the last
 * `LEADER_ACTIVITY_WINDOW_MS` before `now`, and the busiest minute, from one
 * page of fills in any order. */
export function measureLeaderActivity(fills: readonly LeaderActivityFill[], now: number, pageFull: boolean): LeaderActivity {
  const since = now - LEADER_ACTIVITY_WINDOW_MS;
  const firstFill = new Map<string, number>();
  for (const fill of fills) {
    if (fill.time < since || fill.time > now) continue;
    const key = String(fill.oid), seen = firstFill.get(key);
    if (seen === undefined || fill.time < seen) firstFill.set(key, fill.time);
  }
  const starts = [...firstFill.values()].sort((a, b) => a - b);
  let peakPerMinute = 0, hi = 0;
  // Two pointers: the orders starting in [start, start + 60 s).
  starts.forEach((start, lo) => {
    while (hi < starts.length && starts[hi]! < start + MINUTE_MS) hi++;
    peakPerMinute = Math.max(peakPerMinute, hi - lo);
  });
  return { orders: firstFill.size, peakPerMinute, saturated: pageFull };
}

/** Why this activity is too much to copy, or null when it fits. A saturated
 * read counts as over the daily limit: a full page is 2,000 fills. */
export function leaderActivityVerdict(activity: LeaderActivity): LeaderActivityReason | null {
  if (activity.saturated || activity.orders > MAX_LEADER_ORDERS_PER_DAY) return "orders_per_day";
  if (activity.peakPerMinute > MAX_LEADER_ORDERS_PER_MINUTE) return "orders_per_minute";
  return null;
}

/** The copy-activity answer for a measurement. */
export function leaderCopyActivity(activity: LeaderActivity, measuredAt: Date): LeaderCopyActivity {
  const reason = leaderActivityVerdict(activity);
  return { ...activity, fits: reason === null, reason,
    limits: { perDay: MAX_LEADER_ORDERS_PER_DAY, perMinute: MAX_LEADER_ORDERS_PER_MINUTE }, measuredAt };
}
