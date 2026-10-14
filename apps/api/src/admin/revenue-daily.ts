import { maxUnits, toUnits, unitsToNumber, type Units } from "./decimal.js";
import { DAY_MS } from '../config/constants/time.js';


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

/** First UTC day in the range ("7d" = today and the 6 days before), or null for "all". */
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

interface DailyRevenue {
  day: string;
  builder: number;
  referral: number;
}

/**
 * Revenue per UTC day from cumulative snapshots: the day's last snapshot minus the last one
 * before it, per series, clamped at 0 (claims don't move the cumulative totals).
 * - The first tracked day's first snapshot is its baseline (pre-tracking income isn't booked).
 * - A day without snapshots gets 0; the gap's income lands on the next day with one.
 * - Days run without holes from `fromDay` (or the first snapshot's day) to the last snapshot's.
 * `points` sorted by `takenAt`; ones before `fromDay` give its baseline. `totalUnits` = builder + referral.
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
