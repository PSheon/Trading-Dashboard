/**
 * CopyDog's 日曆 (the third chart tab): monthly PnL and return of the whole
 * account (perp + spot), one row per year (newest first), twelve month
 * cells and a 全年 cell, shaded by size. Rebuilt from its bundle
 * (2026-10-01) so the numbers match it cell for cell.
 *
 * Source: the all-time perp + spot portfolio series (Hyperliquid's
 * `portfolio` allTime, the same series CopyDog's `chart?kind=combined` sends
 * for pnl and value). Not reconstructed trades: the series already carries
 * funding, fees and spot, and the net deposits needed for the return
 * (account value − PnL) come from the same points.
 *
 * - A month's PnL is its last cumulative PnL minus the previous month's
 *   last (the first month starts from the first point), so months add up
 *   to the history's PnL.
 * - A month's return is its PnL ÷ the month's peak net deposits
 *   (account value − PnL at each point, the value taken at or before the
 *   point), capped at −100%; null below $100 of capital or above +10,000%.
 *   A year's return is the year's PnL ÷ the year's peak net deposits.
 * - A month without a point is left blank; a month whose value (PnL or
 *   return, whichever the $ / % toggle shows) is 0 or null shows "—".
 * - Months are the viewer's local calendar months, as on CopyDog.
 */

export type SeriesPoint = readonly [number, number];

export interface CalendarCell {
  pnl: number;
  roi: number | null;
}

export interface CalendarYear {
  year: number;
  /** January … December; null where the history has no point. */
  months: Array<CalendarCell | null>;
  pnl: number;
  peakNetDeposits: number | null;
  roi: number | null;
}

export interface PnlCalendar {
  rows: CalendarYear[];
  maxAbsPnl: number;
  maxAbsRoi: number;
}

/** Below this much capital a return means nothing (CopyDog's 100). */
export const MIN_CALENDAR_CAPITAL = 100;

/** PnL ÷ peak net deposits, capped at −100%; null below the minimum capital
 * or above +10,000%. */
export function calendarRoi(pnl: number, peakNetDeposits: number | null): number | null {
  if (peakNetDeposits == null || peakNetDeposits < MIN_CALENDAR_CAPITAL) return null;
  const r = Math.max(-1, pnl / peakNetDeposits);
  return r > 100 ? null : r;
}

export type MonthOf = (ms: number) => { year: number; month: number };
const localMonth: MonthOf = (ms) => {
  const d = new Date(ms);
  return { year: d.getFullYear(), month: d.getMonth() };
};

/** The calendar of a cumulative PnL series and its account values; null
 * without points. `monthOf` defaults to the local time zone. */
export function pnlCalendar(
  pnl: readonly SeriesPoint[] | undefined,
  accountValue: readonly SeriesPoint[] | undefined,
  monthOf: MonthOf = localMonth,
): PnlCalendar | null {
  if (!pnl || pnl.length === 0) return null;
  const points = [...pnl].sort((a, b) => a[0] - b[0]);
  const values = [...(accountValue ?? [])].sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  /** The account value at or before `ts` (the first one before any). */
  const valueAt = (ts: number): number | null => {
    while (cursor < values.length && values[cursor][0] <= ts) cursor++;
    return cursor > 0 ? values[cursor - 1][1] : values.length ? values[0][1] : null;
  };

  const months: Array<{ year: number; month: number; endCum: number; peak: number | null }> = [];
  const byKey = new Map<string, (typeof months)[number]>();
  for (const [ts, cum] of points) {
    const { year, month } = monthOf(ts);
    const value = valueAt(ts);
    const netDeposits = value == null ? null : value - cum;
    const key = `${year}-${month}`;
    let m = byKey.get(key);
    if (!m) {
      m = { year, month, endCum: cum, peak: netDeposits };
      byKey.set(key, m);
      months.push(m);
    }
    m.endCum = cum;
    if (netDeposits != null) m.peak = m.peak == null ? netDeposits : Math.max(m.peak, netDeposits);
  }

  const years = new Map<number, CalendarYear>();
  let previous = points[0][1];
  let maxAbsPnl = 0;
  let maxAbsRoi = 0;
  for (const m of months) {
    const monthPnl = m.endCum - previous;
    previous = m.endCum;
    const roi = calendarRoi(monthPnl, m.peak);
    let y = years.get(m.year);
    if (!y) {
      y = { year: m.year, months: Array(12).fill(null), pnl: 0, peakNetDeposits: null, roi: null };
      years.set(m.year, y);
    }
    y.months[m.month] = { pnl: monthPnl, roi };
    y.pnl += monthPnl;
    y.peakNetDeposits = y.peakNetDeposits == null ? m.peak : m.peak == null ? y.peakNetDeposits : Math.max(y.peakNetDeposits, m.peak);
    maxAbsPnl = Math.max(maxAbsPnl, Math.abs(monthPnl));
    if (roi != null) maxAbsRoi = Math.max(maxAbsRoi, Math.abs(roi));
  }
  for (const y of years.values()) y.roi = calendarRoi(y.pnl, y.peakNetDeposits);
  return { rows: [...years.values()].sort((a, b) => b.year - a.year), maxAbsPnl, maxAbsRoi };
}

/** How strongly a month cell is tinted, in percent of the PnL colour mixed
 * into the cell grey: 11 + 19 × √(|v| ÷ max), rounded (CopyDog's). Null for
 * 0 / no value (the grey "—" cell). */
export function calendarShade(value: number | null, max: number): number | null {
  if (value == null || value === 0) return null;
  const r = max > 0 ? Math.sqrt(Math.min(1, Math.abs(value) / max)) : 0.5;
  return Math.round(11 + r * 19);
}

/** The 全年 cell's fixed tint. */
export const CALENDAR_OVERALL_SHADE = 26;
