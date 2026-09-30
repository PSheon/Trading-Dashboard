/**
 * The trader share card (CopyDog's 分享交易員主頁, its "聚焦卡"): the data and
 * formats behind the PNG that `/trader/[address]/share-image` renders and
 * the trader page uses as its Open Graph image. Pure: no fetching, no JSX.
 *
 * CopyDog's card (bundle, 2026-10-01): avatar in a brand ring and the
 * trader's name; the period's perp PnL in whole dollars ("+$23,213,658"),
 * its ROI ("+1.5k%") and win rate ("41%"); the wordmark. Two formats,
 * 16:9 (640 × 360) and 4:5 (480 × 600), four periods (24H / 7D / 30D /
 * ALL, ALL first). Orbie adds the period's PnL line faintly behind the
 * figure.
 */

import type { TraderWindow } from "@/lib/contracts";

export type ShareFormat = "landscape" | "portrait";

/** Design size of each format; the PNG is rendered at `SHARE_SCALE` ×. */
export const SHARE_FORMATS: Record<ShareFormat, { w: number; h: number; label: string }> = {
  landscape: { w: 640, h: 360, label: "16:9" },
  portrait: { w: 480, h: 600, label: "4:5" },
};
export const SHARE_SCALE = 2;

export const SHARE_PERIODS: Array<[TraderWindow, string]> = [
  ["day", "24H"],
  ["week", "7D"],
  ["month", "30D"],
  ["allTime", "ALL"],
];

export function isShareFormat(v: string | null | undefined): v is ShareFormat {
  return v === "landscape" || v === "portrait";
}
export function isSharePeriod(v: string | null | undefined): v is TraderWindow {
  return SHARE_PERIODS.some(([p]) => p === v);
}
export const periodLabel = (p: TraderWindow) => SHARE_PERIODS.find(([x]) => x === p)?.[1] ?? "ALL";

/** "+$23,213,658", "-$759,587", "$0": whole dollars with separators. */
export function sharePnl(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  const n = Math.round(Math.abs(v));
  if (n === 0) return "$0";
  return `${v > 0 ? "+" : "-"}$${n.toLocaleString("en-US")}`;
}

/** "+1.5k%", "+47.4k%", "+384%", "-9.7%" (CopyDog's card ROI). */
export function shareRoi(roi: number | null | undefined): string {
  if (roi == null || Number.isNaN(roi)) return "—";
  const pct = roi * 100;
  const sign = pct >= 0 ? "+" : "-";
  const n = Math.abs(pct);
  if (n >= 1e5) return `${sign}${(n / 1e3).toFixed(0)}k%`;
  if (n >= 1e3) return `${sign}${(n / 1e3).toFixed(1)}k%`;
  return `${sign}${n.toFixed(n >= 100 ? 0 : 1)}%`;
}

/** "41%" (whole percent). */
export function shareWinRate(w: number | null | undefined): string {
  return w == null || Number.isNaN(w) ? "—" : `${(w * 100).toFixed(0)}%`;
}

export interface ShareCardData {
  address: string;
  name: string;
  /** A data: URI (PNG / JPEG) for the image renderer, or an api path. */
  avatar: string | null;
  period: TraderWindow;
  pnl: number | null;
  roi: number | null;
  winRate: number | null;
  /** The period's cumulative PnL, downsampled. */
  line: number[];
}

/** The name on the card: the KOL's or the trader's name, else the short
 * address ("0xbf73…5d58"). */
export function shareName(p: { address: string; displayName?: string | null; kol?: { displayName: string | null } | null }): string {
  const name = p.kol?.displayName?.trim() || p.displayName?.trim();
  return name || `${p.address.slice(0, 6)}…${p.address.slice(-4)}`;
}

/** At most `n` points, evenly picked, the last one kept. */
export function downsample(values: number[], n = 60): number[] {
  if (values.length <= n) return values;
  const out: number[] = [];
  for (let i = 0; i < n - 1; i++) out.push(values[Math.floor((i * (values.length - 1)) / (n - 1))]);
  out.push(values[values.length - 1]);
  return out;
}

/** The card's data from the api's profile, the period's perp portfolio and
 * its trade analytics (all-time win rate when the period has none). */
export function shareCardData(input: {
  address: string;
  profile?: { displayName?: string | null; kol?: { displayName: string | null } | null } | null;
  avatar?: string | null;
  period: TraderWindow;
  portfolio?: { pnl: Array<[number, number]> | ReadonlyArray<readonly [number, number]>; roi: number | null } | null;
  winRate?: number | null;
  allTimeWinRate?: number | null;
}): ShareCardData {
  const series = input.portfolio?.pnl ?? [];
  return {
    address: input.address,
    name: shareName({ address: input.address, ...(input.profile ?? {}) }),
    avatar: input.avatar ?? null,
    period: input.period,
    pnl: series.length ? series[series.length - 1][1] : null,
    roi: input.portfolio?.roi ?? null,
    winRate: input.winRate ?? input.allTimeWinRate ?? null,
    line: downsample(series.map(([, v]) => v)),
  };
}

/** An SVG path of `values` filling `w` × `h` (y up), and the closed area
 * under it; null with fewer than two points. */
export function sparklinePaths(values: number[], w: number, h: number): { line: string; area: string } | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - ((v - min) / span) * h] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return { line, area: `${line} L${w} ${h} L0 ${h} Z` };
}

/** "orbie-solanadoomer-7d-portrait" (CopyDog's file name pattern). */
export function shareFileName(name: string, period: TraderWindow, format: ShareFormat): string {
  const safe = name.replace(/[^\w.-]+/g, "").slice(0, 16) || "trader";
  return `orbie-${safe}-${periodLabel(period).toLowerCase()}-${format}`;
}

/** The share image's path for a trader, period and format. */
export function shareImagePath(address: string, period: TraderWindow, format: ShareFormat): string {
  return `/trader/${address}/share-image?period=${period}&format=${format}`;
}
