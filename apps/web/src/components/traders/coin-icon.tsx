import { cn } from "cn";

import { coinDex, coinLabel } from "@/lib/format";

/**
 * Coin glyphs drawn from type and colour only (no third-party logos):
 * a disc in the coin's familiar colour with a symbol, or, for builder-dex
 * markets such as stocks ("xyz:TSLA"), a rounded square with the ticker.
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
        background: dex ? `hsl(${h} 30% 24%)` : `hsl(${h} 55% 45%)`,
        color: dex ? `hsl(${h} 70% 82%)` : "#fff",
      }}
    >
      {label.replace(/^@/, "").slice(0, label.length > 4 ? 3 : 4)}
    </span>
  );
}
