import { ImageResponse } from "next/og";

import { BRAND, markSvgBody } from "@/components/brand/logo";
import { APP_NAME, APP_URL } from "@/lib/config";
import { coinIcons } from "@/lib/coin-icon-source";
import { SHARE_FORMATS, SHARE_SCALE, type ShareFormat } from "@/lib/share-card";
import { loadFonts } from "@/lib/share-card-image";
import { cells, chipText, compactPnl, heroPnl, pctText, cardPrice, type TradeCardData, type TradeCardStyle } from "@/lib/trade-card";

/**
 * Orbie's tones for the two styles. App Card: the site's navy with green or
 * rose figures. Poster: a light sheet, mint for a gain and rose for a loss,
 * navy ink (CopyDog's poster is lime / salmon; these are Orbie's).
 */
export function tones(style: TradeCardStyle, win: boolean) {
  return style === "card"
    ? { sheet: "#0f0d1f", fg: "#f4f2fb", hero: win ? "#34d399" : "#f4506f", muted: "#b9b5d0", hairline: "rgba(255,255,255,0.10)", halo: "rgba(255,255,255,0.07)", chipBg: BRAND.cream, chipFg: BRAND.navy, ring: "rgba(255,122,69,0.22)", mark: "dark" as const }
    : { sheet: win ? "#c9f2df" : "#ffd3dc", fg: "#14112b", hero: "#14112b", muted: "rgba(20,17,43,0.68)", hairline: "rgba(20,17,43,0.22)", halo: "rgba(20,17,43,0.08)", chipBg: "#14112b", chipFg: BRAND.cream, ring: "rgba(20,17,43,0.10)", mark: "light" as const };
}
type Tones = ReturnType<typeof tones>;

const markUri = (variant: "dark" | "light", px: number) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${markSvgBody(variant, px)}</svg>`).toString("base64")}`;

/** Hero size: as large as allowed, shrunk to fit `room` px (figures ~0.6 em). */
const fit = (text: string, max: number, room: number) => Math.max(16, Math.min(max, Math.floor(room / (Math.max(1, text.length) * 0.6))));

/** What satori's renderer can't draw from an embedded SVG (references,
 * filters, text in outside fonts, nested or external images, styles):
 * such an icon falls back to the ticker disc. */
const UNSAFE_SVG = /<\s*(?:use|filter|text|tspan|foreignObject|image|style|script)\b|xlink:href|@font-face|url\(\s*['"]?(?:https?:|\/\/)/i;

/**
 * The coin's logo for a card: the very SVG the page's CoinIcon shows (the
 * same server-side lookup /api/coin-icon/<coin> answers with), embedded as
 * a data URI; null for a coin without one (stocks, new markets), when the
 * lookup fails, or when the SVG holds what the renderer can't draw.
 */
export async function cardCoinIcon(coin: string, source: Pick<typeof coinIcons, "get"> = coinIcons): Promise<string | null> {
  if (process.env.NEXT_TEST_MODE === "1") return null;
  const icon = await source.get(coin).catch(() => null);
  if (!icon || UNSAFE_SVG.test(icon.svg)) return null;
  return `data:image/svg+xml;base64,${Buffer.from(icon.svg).toString("base64")}`;
}

/** The coin on a card: its logo in a round frame when it has one, else its
 * ticker in a planet-orange disc. */
function CoinBadge({ coin, icon, size, t }: { coin: string; icon: string | null; size: number; t: Tones }) {
  if (icon) {
    return (
      <div style={{ display: "flex", width: size, height: size, borderRadius: 9999, alignItems: "center", justifyContent: "center", overflow: "hidden", border: `${Math.max(2, size * 0.04)}px solid ${t.halo}` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt="" src={icon} width={size} height={size} style={{ borderRadius: 9999 }} />
      </div>
    );
  }
  const ticker = (coin.includes(":") ? coin.split(":")[1]! : coin).replace(/^k(?=[A-Z])/, "").slice(0, 4);
  return (
    <div style={{ display: "flex", width: size, height: size, borderRadius: 9999, alignItems: "center", justifyContent: "center", background: `linear-gradient(150deg, #ffb38f 0%, ${BRAND.orange} 55%, #c9471a 100%)`, color: BRAND.navy, fontSize: size * (ticker.length > 3 ? 0.26 : 0.32), fontWeight: 800, letterSpacing: "-0.02em", border: `${Math.max(2, size * 0.04)}px solid ${t.halo}` }}>
      {ticker}
    </div>
  );
}

function Chip({ text, s, t, scale = 1 }: { text: string; s: number; t: Tones; scale?: number }) {
  const k = s * scale;
  return (
    <div style={{ display: "flex", background: t.chipBg, color: t.chipFg, borderRadius: 999, padding: `${4.5 * k}px ${13 * k}px`, fontSize: 12.5 * k, fontWeight: 800, letterSpacing: "0.02em", whiteSpace: "nowrap" }}>
      {text}
    </div>
  );
}

function PaperTag({ s, t }: { s: number; t: Tones }) {
  return (
    <div style={{ display: "flex", position: "absolute", top: 14 * s, right: 14 * s, border: `1px solid ${t.hairline}`, color: t.muted, borderRadius: 999, padding: `${3 * s}px ${8 * s}px`, fontSize: 9.5 * s, fontWeight: 800, letterSpacing: "0.08em" }}>
      PAPER · SIMULATED FUNDS
    </div>
  );
}

function Brand({ s, t, align = "center" }: { s: number; t: Tones; align?: "center" | "start" }) {
  const host = APP_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: align === "center" ? "center" : "flex-start", gap: 7 * s }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt="" src={markUri(t.mark, 22 * s)} width={20 * s} height={20 * s} />
      <div style={{ display: "flex", fontFamily: "Fredoka", fontSize: 17 * s, fontWeight: 600, color: t.fg }}>{APP_NAME.toLowerCase()}</div>
      <div style={{ display: "flex", fontSize: 10 * s, fontWeight: 600, color: t.muted, marginLeft: 4 * s }}>{host}</div>
    </div>
  );
}

/** Orbie's ring, faint behind the figures. */
function Orbit({ w, h, s, t }: { w: number; h: number; s: number; t: Tones }) {
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: "absolute", left: 0, top: 0 }}>
      <g transform={`rotate(-18 ${w / 2} ${h / 2})`}>
        <ellipse cx={w / 2} cy={h / 2} rx={w * 0.62} ry={h * 0.2} fill="none" stroke={t.ring} strokeWidth={2.4 * s} />
        <circle cx={w / 2 + w * 0.42} cy={h / 2 + h * 0.13} r={6 * s} fill={t.ring} />
      </g>
    </svg>
  );
}

function Tall({ d, icon, w, h, s, t }: { d: TradeCardData; icon: string | null; w: number; h: number; s: number; t: Tones }) {
  const hero = heroPnl(d.pnl);
  const up = (d.pnlPct ?? d.pnl) >= 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", position: "relative", width: w, height: h, background: t.sheet, color: t.fg, padding: `${42 * s}px ${24 * s}px ${26 * s}px`, fontFamily: "Host Grotesk" }}>
      <Orbit w={w} h={h} s={s} t={t} />
      {d.paper ? <PaperTag s={s} t={t} /> : null}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ display: "flex", width: 88 * s, height: 88 * s, borderRadius: 9999, background: t.halo, alignItems: "center", justifyContent: "center" }}>
          <CoinBadge coin={d.coin} icon={icon} size={62 * s} t={t} />
        </div>
        <div style={{ display: "flex", marginTop: -13 * s }}><Chip text={chipText(d)} s={s} t={t} scale={1.5} /></div>
      </div>
      <div style={{ display: "flex", flex: 1.15 }} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ display: "flex", fontSize: fit(hero, 82 * s, w * 0.88), fontWeight: 800, lineHeight: 0.95, letterSpacing: "-0.04em", color: t.hero }}>{hero}</div>
        {d.pnlPct !== null ? (
          <div style={{ display: "flex", alignItems: "center", gap: 7 * s, marginTop: 15 * s, fontSize: 19 * s, fontWeight: 800, color: t.hero }}>
            <div style={{ display: "flex", fontSize: 15.5 * s }}>{up ? "↗" : "↘"}</div>{pctText(d.pnlPct)}
          </div>
        ) : null}
        <div style={{ display: "flex", fontSize: 13 * s, fontWeight: 600, marginTop: (d.pnlPct !== null ? 8 : 14) * s, color: t.muted, letterSpacing: "0.04em", textTransform: "uppercase" }}>{d.closed ? "Realized PnL" : "Unrealized PnL"}</div>
      </div>
      <div style={{ display: "flex", flex: 1.3 }} />
      <div style={{ display: "flex", width: "100%", justifyContent: "center" }}>
        {cells(d).map(([value, label], i) => (
          <div key={label} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, gap: 6 * s, borderLeft: i ? `1px solid ${t.hairline}` : "none", padding: `${2 * s}px ${8 * s}px` }}>
            <div style={{ display: "flex", fontSize: 17 * s, fontWeight: 800, whiteSpace: "nowrap" }}>{value}</div>
            <div style={{ display: "flex", fontSize: 12 * s, fontWeight: 600, color: t.muted }}>{label}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flex: 1 }} />
      <Brand s={s} t={t} />
    </div>
  );
}

function Wide({ d, icon, w, h, s, t }: { d: TradeCardData; icon: string | null; w: number; h: number; s: number; t: Tones }) {
  const hero = compactPnl(d.pnl);
  const stats: Array<[string, string]> = [
    ["ROI", d.pnlPct === null ? "—" : `${d.pnlPct >= 0 ? "+" : "-"}${pctText(d.pnlPct)}`],
    ["Entry", cardPrice(d.entryPx)],
    [d.closed ? "Exit" : "Mark", cardPrice(d.closed ? d.exitPx : d.markPx)],
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "space-between", position: "relative", width: w, height: h, background: t.sheet, color: t.fg, padding: `${30 * s}px ${32 * s}px`, fontFamily: "Host Grotesk" }}>
      <Orbit w={w} h={h} s={s} t={t} />
      {d.paper ? <PaperTag s={s} t={t} /> : null}
      <div style={{ display: "flex", alignItems: "center", gap: 10 * s }}>
        <CoinBadge coin={d.coin} icon={icon} size={48 * s} t={t} />
        <Chip text={chipText(d)} s={s} t={t} scale={1.35} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 * s }}>
        <div style={{ display: "flex", fontSize: 12 * s, fontWeight: 600, color: t.muted, letterSpacing: "0.04em", textTransform: "uppercase" }}>{d.closed ? "Realized PnL" : "Unrealized PnL"}</div>
        <div style={{ display: "flex", fontSize: fit(hero, 64 * s, (w - 64 * s) * 0.92), fontWeight: 800, lineHeight: 0.95, letterSpacing: "-0.04em", color: t.hero }}>{hero}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 22 * s }}>
        {stats.map(([label, value], i) => (
          <div key={label} style={{ display: "flex", flexDirection: "column", gap: 5 * s, paddingLeft: i ? 22 * s : 0, borderLeft: i ? `1px solid ${t.hairline}` : "none" }}>
            <div style={{ display: "flex", fontSize: 11 * s, fontWeight: 600, color: t.muted, letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</div>
            <div style={{ display: "flex", fontSize: 19 * s, fontWeight: 800, color: label === "ROI" ? t.hero : t.fg }}>{value}</div>
          </div>
        ))}
      </div>
      <Brand s={s} t={t} align="start" />
    </div>
  );
}

/** The card as a PNG at twice the design size (as the trader card). */
export async function renderTradeCard(d: TradeCardData, style: TradeCardStyle, format: ShareFormat, options: { headers?: Record<string, string> } = {}) {
  const design = SHARE_FORMATS[format];
  const width = design.w * SHARE_SCALE;
  const height = design.h * SHARE_SCALE;
  const s = SHARE_SCALE;
  const t = tones(style, (d.pnlPct ?? d.pnl) >= 0);
  const Body = format === "portrait" ? Tall : Wide;
  const [fonts, icon] = await Promise.all([loadFonts(), cardCoinIcon(d.coin)]);
  return new ImageResponse(<Body d={d} icon={icon} w={width} h={height} s={s} t={t} />, { width, height, fonts, headers: options.headers });
}
