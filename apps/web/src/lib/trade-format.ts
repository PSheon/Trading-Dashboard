import { TIME_ZONE } from "@/i18n/config";
/**
 * Number and time formats of CopyDog's trader-page trade views (its JS
 * bundle), used by Orbie's win-rate tile, rail trade sections and the 表現 /
 * 交易 tabs so they read the same. CopyDog uses these in every locale.
 */

const abs = Math.abs;

/** "$802.68", "$54.813", "$0.4600", "$0.003100": digits by magnitude. */
export function price(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "-";
  const n = abs(value);
  const digits = n < 1e-4 ? 8 : n < 0.01 ? 6 : n < 1 ? 4 : n < 100 ? 3 : 2;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** "29.2%". */
export function pct1(value: number | null | undefined): string {
  return value == null || Number.isNaN(value) ? "0%" : `${(value * 100).toFixed(1)}%`;
}

/** Win-rate tone: ≥ 50% good, ≥ 35% middling, else poor. */
export function winRateTone(value: number | null | undefined): "positive" | "warning" | "negative" | null {
  if (value == null || Number.isNaN(value)) return null;
  return value >= 0.5 ? "positive" : value >= 0.35 ? "warning" : "negative";
}

/** "Sep 19, 06:52" (en-US, 24 h), in the site's one time zone — the same
 * zone every other time on the page is written in (lib/format), so a trade
 * table and the chart beside it never disagree by the viewer's offset. */
export function shortTime(value: string | number | Date | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TIME_ZONE });
}

/** "20d 17h", "21h 12m", "55m", "19s". */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null) return "-";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

/** Net PnL + funding ÷ entry notional, % (null when meaningless). */
export function tradeReturnPct(trade: { size: number; entryPx: number; fees: number; realizedPnl: number; netPnl: number; funding: number | null; side: string }): number | null {
  const notional = trade.size * trade.entryPx;
  if (!(notional >= 1) || abs(trade.fees) > notional) return null;
  const gross = trade.realizedPnl / notional;
  if ((trade.side === "long" && gross < -1.05) || (trade.side !== "long" && gross > 1.05)) return null;
  return ((trade.netPnl + (trade.funding ?? 0)) / notional) * 100;
}

/** Sizes and token amounts: "1.27K", "3.48M", "59.53", "0.36642". */
export function qty(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "0";
  const n = abs(value);
  if (n >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 5 });
}

/** "+12.34%" (2 decimals; "+" only above 0). */
export function signedPct2(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

/** "Sep 27 9:32PM": the live feed's time stamp. */
export function feedTime(value: string | number | Date | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  const day = d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: TIME_ZONE });
  const time = d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIME_ZONE }).replace(" ", "");
  return `${day} ${time}`;
}

/**
 * Distance from the mark to the liquidation price, % of the mark, and
 * CopyDog's tone for it: ≤ 2% critical, ≤ 5% danger, ≤ 15% warn, else safe.
 */
export function liqDistance(liqPx: number | null | undefined, markPx: number | null | undefined): { pct: number; tone: "critical" | "danger" | "warn" | "safe" } | null {
  const liq = Number(liqPx) || 0;
  const mark = Number(markPx) || 0;
  if (liq <= 0 || mark <= 0) return null;
  const pct = (abs(liq - mark) / mark) * 100;
  return { pct, tone: pct <= 2 ? "critical" : pct <= 5 ? "danger" : pct <= 15 ? "warn" : "safe" };
}

/** Signed class for a PnL figure (none for ~0). */
export function pnlTone(value: number): "text-positive" | "text-negative" | "" {
  return abs(value) < 0.005 ? "" : value > 0 ? "text-positive" : "text-negative";
}

/**
 * The time a win rate's trades start from when they do not cover the whole
 * account, else null: the analytics say their history is partial, or the
 * account's perp PnL had already moved before the first fill they read (it
 * moves only by trading and funding, so there were earlier trades). CopyDog
 * presents such a sample as all-time; Orbie says where it starts.
 */
export function partialSampleSince(
  coverage: { from: string | Date | null; truncated: boolean } | undefined,
  perpPnl: ReadonlyArray<readonly [number, number]> | undefined,
): number | null {
  if (!coverage || coverage.from === null) return null;
  const from = new Date(coverage.from).getTime();
  if (!Number.isFinite(from)) return null;
  if (coverage.truncated) return from;
  let before: number | null = null;
  for (const [time, pnl] of perpPnl ?? []) if (time <= from) before = pnl;
  return before !== null && Math.abs(before) >= 1 ? from : null;
}
