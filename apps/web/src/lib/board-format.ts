/**
 * CopyDog's number formats on its explore and home boards (its JS bundle,
 * 2026-09-30), used in every locale as CopyDog does.
 */

const n = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? null : v);

/** Grid card PnL: "+$5,959,218", "-$12,400", "$0". */
export function boardPnl(value: number | null | undefined): string {
  const v = n(value);
  if (v === null || Math.abs(v) < 0.5) return "$0";
  return `${v >= 0 ? "+" : "-"}$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
}

/** Grid card / list ROI (a ratio): "+897.55%", "-3.10%". */
export function boardRoi(ratio: number | null | undefined): string {
  const v = n(ratio);
  if (v === null) return "-";
  const pct = v * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

/** List equity: "$2,636,620". */
export function boardUsd(value: number | null | undefined): string {
  const v = n(value);
  return v === null ? "$0" : `$${Math.round(v).toLocaleString("en-US")}`;
}

/** Home card ROI pill (unsigned; the arrow carries the sign): "3817%",
 * "47K%", "2M%". */
export function roiPillShort(ratio: number | null | undefined): string {
  const pct = Math.abs((n(ratio) ?? 0) * 100);
  if (pct >= 1e6) return `${Math.round(pct / 1e6)}M%`;
  if (pct >= 1e4) return `${Math.round(pct / 1e3)}K%`;
  return `${Math.round(pct)}%`;
}

/** Mobile list ROI pill: "1,486%" (unsigned, whole percent). */
export function roiPillWhole(ratio: number | null | undefined): string {
  return `${Math.round(Math.abs((n(ratio) ?? 0) * 100)).toLocaleString("en-US")}%`;
}

/** Last trade as CopyDog tags cards: "52m ago", "21h ago", "3d ago". */
export function agoShort(time: string | number | Date | null | undefined, now = Date.now()): string | null {
  if (time === null || time === undefined) return null;
  const t = new Date(time).getTime();
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The label CopyDog shows for a board coin ("xyz:SP500" → "SPX",
 * "xyz:CL" → "Oil"); `t` supplies the translated names. */
export function boardCoinLabel(coin: string, t: (key: "home.markets.gold" | "home.markets.oil") => string): string {
  const name = coin.includes(":") ? coin.slice(coin.indexOf(":") + 1) : coin;
  if (name === "SP500") return "SPX";
  if (name === "GOLD") return t("home.markets.gold");
  if (name === "CL") return t("home.markets.oil");
  return name;
}
