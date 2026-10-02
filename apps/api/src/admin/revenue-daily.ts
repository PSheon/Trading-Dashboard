import { maxUnits, toUnits, unitsToNumber, type Units } from "./decimal.js";

const DAY_MS = 86_400_000;

export type RevenueRange = "7d" | "30d" | "90d" | "all";

const RANGE_DAYS: Record<Exclude<RevenueRange, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };

/** "YYYY-MM-DD" of the UTC calendar day containing `at`. Days are UTC, like
 * every time the site shows (owner, 2026-10-02; they were Asia/Taipei). */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The instant a UTC day ("YYYY-MM-DD") starts. */
export function utcDayStart(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`));
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * First UTC day in the range, or null for "all". "7d" is today and the 6
 * days before it, and so on.
 */
export function rangeStartDay(range: RevenueRange, now: Date): string | null {
  if (range === "all") return null;
  return addDays(utcDay(now), -(RANGE_DAYS[range] - 1));
}

/** One snapshot's cumulative series. Amounts as decimal strings. */
export interface RevenuePoint {
  takenAt: Date;
  builder: string;
  referral: string;
}

export interface DailyRevenue {
  day: string;
  builder: number;
  referral: number;
}

/**
 * Revenue earned per UTC day from cumulative snapshots.
 *
 * For each day with snapshots: the day's last snapshot minus the last
 * snapshot before that day, per series, clamped at 0. Builder and referral
 * totals are cumulative and don't move when rewards are claimed (a claim
 * only shifts unclaimed → claimed), so a claim earns nothing; a series that
 * goes down (it shouldn't) counts as 0 rather than negative revenue.
 *
 * - The first day ever tracked has no earlier snapshot; its first snapshot
 *   is the baseline, so income from before tracking began is not booked on
 *   that day.
 * - A day with no snapshot gets 0, and what was earned during the gap is
 *   booked on the next day that has one.
 * - Days run from `fromDay` (or the first snapshot's day) to the last
 *   snapshot's day, without holes.
 *
 * `points` must be sorted by `takenAt` and may start with snapshots before
 * `fromDay`: the last of those is the baseline for `fromDay`. `total` is
 * the exact sum of the returned days; `totalUnits` is builder + referral.
 */
export function dailyRevenue(
  points: RevenuePoint[],
  fromDay: string | null,
): { daily: DailyRevenue[]; total: { builder: number; referral: number }; totalUnits: Units } {
  const daily: DailyRevenue[] = [];
  let totalBuilder = 0n;
  let totalReferral = 0n;
  if (points.length === 0) return { daily, total: { builder: 0, referral: 0 }, totalUnits: 0n };

  const lastOfDay = new Map<string, { builder: Units; referral: Units }>();
  for (const point of points) {
    lastOfDay.set(utcDay(point.takenAt), {
      builder: toUnits(point.builder),
      referral: toUnits(point.referral),
    });
  }

  const first = points[0];
  let previous = { builder: toUnits(first.builder), referral: toUnits(first.referral) };
  const firstDay = utcDay(first.takenAt);
  const lastDay = utcDay(points[points.length - 1].takenAt);

  for (let day = firstDay; day <= lastDay; day = addDays(day, 1)) {
    const end = lastOfDay.get(day);
    let builder = 0n;
    let referral = 0n;
    if (end) {
      builder = maxUnits(0n, end.builder - previous.builder);
      referral = maxUnits(0n, end.referral - previous.referral);
      previous = end;
    }
    if (fromDay === null || day >= fromDay) {
      daily.push({ day, builder: unitsToNumber(builder), referral: unitsToNumber(referral) });
      totalBuilder += builder;
      totalReferral += referral;
    }
  }
  return {
    daily,
    total: { builder: unitsToNumber(totalBuilder), referral: unitsToNumber(totalReferral) },
    totalUnits: totalBuilder + totalReferral,
  };
}
