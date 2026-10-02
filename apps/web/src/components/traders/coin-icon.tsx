"use client";

import { useState } from "react";
import { cn } from "cn";

import { coinDex, coinLabel } from "@/lib/format";

/** Hyperliquid draws these dark on a transparent ground; on Orbie's navy
 * they sit on a white disc, as CopyDog shows them. */
const LIGHT_DISC = new Set(["ETH", "NEAR"]);

/** Hyperliquid's own market icon (one SVG per perp, HIP-3 markets
 * included), through this site's cached route: nothing is hot-linked. */
export const coinIconUrl = (coin: string) => `/api/coin-icon/${encodeURIComponent(coin)}`;

/**
 * A market's icon: Hyperliquid's own SVG for the coin, and when it has none
 * (or it fails to load), a glyph drawn from type and colour only: a disc in
 * the coin's familiar colour with a symbol, or, for builder-dex markets
 * such as stocks ("xyz:TSLA"), a rounded square with the ticker.
 */
const KNOWN: Record<string, { bg: string; fg: string; glyph: string }> = {
  BTC: { bg: "#f7931a", fg: "#ffffff", glyph: "₿" },
  ETH: { bg: "#627eea", fg: "#ffffff", glyph: "Ξ" },
  SOL: { bg: "linear-gradient(135deg,#9945ff,#14f195)", fg: "#ffffff", glyph: "◎" },
  HYPE: { bg: "#97fce4", fg: "#0f2e2a", glyph: "H" },
  DOGE: { bg: "#c2a633", fg: "#ffffff", glyph: "Ð" },
  XRP: { bg: "#2b2f36", fg: "#ffffff", glyph: "✕" },
  SUI: { bg: "#4da2ff", fg: "#ffffff", glyph: "S" },
  GOLD: { bg: "linear-gradient(135deg,#f5d77a,#b8860b)", fg: "#3a2a00", glyph: "Au" },
  SILVER: { bg: "linear-gradient(135deg,#e8e8ee,#9a9aa6)", fg: "#2a2a33", glyph: "Ag" },
};

function hue(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function CoinIcon({
  coin,
  size = 20,
  className,
}: {
  coin: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  // Spot ("@107", "PURR/USDC") has no market icon of its own.
  if (!failed && !coin.startsWith("@") && !coin.includes("/")) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- small remote SVGs; next/image adds nothing here
      <img
        src={coinIconUrl(coin)}
        alt=""
        aria-hidden
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn("inline-block shrink-0 rounded-full object-contain", LIGHT_DISC.has(coin) && "bg-white", className)}
        // Padding in px: a percentage resolves against the parent's width,
        // which blew the disc up inside wide boxes (the insights treemap).
        style={{ width: size, height: size, ...(LIGHT_DISC.has(coin) ? { padding: Math.round(size * 0.12) } : {}) }}
      />
    );
  }
  return <CoinGlyph coin={coin} size={size} className={className} />;
}

function CoinGlyph({ coin, size, className }: { coin: string; size: number; className?: string }) {
  const label = coinLabel(coin);
  const dex = coinDex(coin);
  const known = KNOWN[label.toUpperCase()];
  const style: React.CSSProperties = { width: size, height: size, fontSize: size * 0.5 };

  if (known) {
    return (
      <span
        aria-hidden
        className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-bold leading-none", className)}
        style={{ ...style, background: known.bg, color: known.fg, fontSize: known.glyph.length > 1 ? size * 0.4 : size * 0.55 }}
      >
        {known.glyph}
      </span>
    );
  }

  const h = hue(label);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-bold leading-none tracking-tight",
        dex ? "rounded-[30%]" : "rounded-full",
        className,
      )}
      style={{
        ...style,
        fontSize: size * (label.length > 3 ? 0.3 : 0.38),
        // Dark enough for the white initials to pass WCAG AA (4.5:1).
        background: dex ? `hsl(${h} 30% 24%)` : `hsl(${h} 55% 32%)`,
        color: dex ? `hsl(${h} 70% 82%)` : "#fff",
      }}
    >
      {label.replace(/^@/, "").slice(0, label.length > 4 ? 3 : 4)}
    </span>
  );
}
