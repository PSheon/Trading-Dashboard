/**
 * Image cards for one trade or one position (CopyDog's Share Trade / Share
 * Position, bundle `index-Dp4CR15e.js` 2026-10-04): two styles — App Card
 * (dark) and Poster (a light sheet, one colour for a gain, another for a
 * loss) — in 16:9 (640 × 360) and 4:5 (480 × 600). The figures come from
 * the server (the image route reads them), never from the URL, so a card
 * cannot be made to say what the data does not. Pure: no fetching, no JSX.
 */
import { SHARE_FORMATS, type ShareFormat } from "@/lib/share-card";

export type TradeCardStyle = "card" | "poster";
export const TRADE_CARD_STYLES: Array<{ key: TradeCardStyle; label: string }> = [
  { key: "card", label: "App Card" },
  { key: "poster", label: "Poster" },
];
export const isTradeCardStyle = (v: string | null | undefined): v is TradeCardStyle => v === "card" || v === "poster";

export interface TradeCardData {
  coin: string;
  side: "long" | "short";
  leverage: number | null;
  /** USD; after fees for a closed trade, unrealized for an open position. */
  pnl: number;
  /** % (12.3 = 12.3%), or null when it means nothing. */
  pnlPct: number | null;
  entryPx: number | null;
  /** Closed trades. */
  exitPx: number | null;
  /** Open positions. */
  markPx: number | null;
  size: number;
  heldMs: number | null;
  closed: boolean;
  /** A paper copy's trade: the card says the money is simulated. */
  paper: boolean;
}

/** CopyDog's tall-card hero ("+1.2K", "+12.34"), with the dollar sign it leaves out. */
export function heroPnl(v: number): string {
  const n = Math.abs(v);
  const sign = v < 0 ? "-" : "+";
  if (n >= 1e9) return `${sign}$${(n / 1e9).toFixed(n >= 1e10 ? 1 : 2)}B`;
  if (n >= 1e6) return `${sign}$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${sign}$${(n / 1e3).toFixed(1)}K`;
  return `${sign}$${n.toFixed(n >= 100 ? 0 : 2)}`;
}

/** CopyDog's wide-card hero: "+$1.23M", "+$12.3K", "+$1,234.56". */
export function compactPnl(v: number): string {
  const n = Math.abs(v);
  const sign = v < 0 ? "-" : "+";
  if (n >= 1e6) return `${sign}$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e4) return `${sign}$${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return `${sign}$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "12.3%" / "123%" (no sign: the arrow says it). */
export const pctText = (v: number) => `${Math.abs(v).toFixed(Math.abs(v) >= 100 ? 0 : 1)}%`;

/** CopyDog's card prices: "$64,123.5", "$12.34", "$0.001234". */
export function cardPrice(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  if (v >= 1e3) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toPrecision(4)}`;
}

export function cardSize(v: number): string {
  const n = Math.abs(v);
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 5 });
}

export function heldText(ms: number): string {
  const s = ms / 1000;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${Math.floor(s)}s`;
}

/** "BTC · LONG 10×" (HIP-3 markets without their dex prefix). */
export function chipText(d: Pick<TradeCardData, "coin" | "side" | "leverage">): string {
  const coin = d.coin.includes(":") ? d.coin.split(":")[1]! : d.coin;
  return `${coin} · ${d.side.toUpperCase()}${d.leverage ? ` ${Math.round(d.leverage)}×` : ""}`;
}

/** The three cells under a tall card's hero: Entry, Exit or Mark, Held or Size. */
export function cells(d: TradeCardData): Array<[string, string]> {
  return [
    [cardPrice(d.entryPx), "Entry"],
    [cardPrice(d.closed ? d.exitPx : d.markPx), d.closed ? "Exit" : "Mark"],
    d.heldMs !== null ? [heldText(d.heldMs), "Held"] : [cardSize(d.size), "Size"],
  ];
}

/** A card's path (style and format appended by the caller). */
export function tradeCardQuery(style: TradeCardStyle, format: ShareFormat): string {
  return `style=${style}&format=${format}`;
}

export function tradeCardFileName(d: Pick<TradeCardData, "coin" | "closed">, style: TradeCardStyle, format: ShareFormat): string {
  const coin = d.coin.replace(/[^\w-]+/g, "-").slice(0, 16) || "trade";
  return `orbie-${coin}-${d.closed ? "trade" : "position"}-${style}-${format}`;
}

export const tradeCardSize = (format: ShareFormat) => SHARE_FORMATS[format];
