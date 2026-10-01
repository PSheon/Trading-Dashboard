import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

import { BRAND, markSvgBody } from "@/components/brand/logo";
import { APP_NAME, APP_URL } from "@/lib/config";
import {
  SHARE_FORMATS,
  SHARE_SCALE,
  periodLabel,
  sharePnl,
  shareRoi,
  shareWinRate,
  sparklinePaths,
  type ShareCardData,
  type ShareFormat,
} from "@/lib/share-card";

/** Orbie's palette on the card (globals.css). */
const C = {
  bg: "#0f0d1f",
  text: "#f4f2fb",
  muted: "#b9b5d0",
  border: "#38335a",
  primary: "#ff7a45",
  positive: "#34d399",
  negative: "#f4506f",
};

let fonts: Promise<Array<{ name: string; data: Buffer; weight: 600 | 800; style: "normal" }>> | null = null;
/** Inter 600 / 800 (Latin subsets) for the figures and the name, Fredoka
 * 600 for the wordmark: bundled in src/assets, nothing fetched. */
function loadFonts() {
  fonts ??= Promise.all([
    readFile(join(process.cwd(), "src/assets/inter-600-subset.ttf")),
    readFile(join(process.cwd(), "src/assets/inter-800-subset.ttf")),
    readFile(join(process.cwd(), "src/assets/fredoka-600-subset.ttf")),
  ]).then(([i6, i8, fr]) => [
    { name: "Inter", data: i6, weight: 600 as const, style: "normal" as const },
    { name: "Inter", data: i8, weight: 800 as const, style: "normal" as const },
    { name: "Fredoka", data: fr, weight: 600 as const, style: "normal" as const },
  ]);
  return fonts;
}

const markUri = (px: number) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${markSvgBody("dark", px)}</svg>`).toString("base64")}`;

function Avatar({ data, size }: { data: ShareCardData; size: number }) {
  const ring = Math.max(3, size * 0.053);
  return (
    <div
      style={{
        display: "flex",
        padding: ring,
        borderRadius: 9999,
        background: `linear-gradient(150deg, #ffb38f 0%, ${C.primary} 45%, #c9471a 100%)`,
        flexShrink: 0,
      }}
    >
      {data.avatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img alt="" src={data.avatar} width={size} height={size} style={{ width: size, height: size, borderRadius: 9999, objectFit: "cover" }} />
      ) : (
        <div style={{ display: "flex", width: size, height: size, borderRadius: 9999, background: BRAND.navy, alignItems: "center", justifyContent: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="" src={markUri(size)} width={size * 0.62} height={size * 0.62} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color, s, big }: { label: string; value: string; color: string; s: number; big?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: big ? "center" : "flex-start", gap: 7 * s }}>
      <div style={{ fontSize: (big ? 10.7 : 9.6) * s, fontWeight: 600, letterSpacing: "0.08em", color: C.muted, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: (big ? 30 : 24.5) * s, fontWeight: 800, color, letterSpacing: "-0.02em", lineHeight: 1 }}>{value}</div>
    </div>
  );
}

function Footer({ s }: { s: number }) {
  const host = APP_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 * s }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt="" src={markUri(24 * s)} width={22 * s} height={22 * s} />
        <div style={{ fontFamily: "Fredoka", fontSize: 20 * s, fontWeight: 600, color: C.text, letterSpacing: "-0.02em" }}>{APP_NAME.toLowerCase()}</div>
      </div>
      <div style={{ fontSize: 11 * s, fontWeight: 600, color: C.muted, letterSpacing: "0.02em" }}>{host}</div>
    </div>
  );
}

/** CopyDog's dotted card background. */
function Dots({ w, h, s }: { w: number; h: number; s: number }) {
  const step = 16 * s;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: "absolute", left: 0, top: 0 }}>
      <defs>
        <pattern id="dots" width={step} height={step} patternUnits="userSpaceOnUse">
          <circle cx={step / 2} cy={step / 2} r={0.9 * s} fill="#ffffff" fillOpacity="0.07" />
        </pattern>
      </defs>
      <rect width={w} height={h} fill="url(#dots)" />
    </svg>
  );
}

/** The hero figure's size: as large as the design allows, shrunk to fit
 * `room` design px (Inter 800 figures run ~0.62 em). */
export function heroSize(text: string, max: number, room: number): number {
  return Math.min(max, room / (Math.max(text.length, 1) * 0.62));
}

/** The period's PnL line, faint, filling the card's lower half. */
function Line({ data, w, h, s }: { data: ShareCardData; w: number; h: number; s: number }) {
  const paths = sparklinePaths(data.line, w, h);
  if (!paths) return null;
  const color = (data.pnl ?? 0) >= 0 ? C.positive : C.negative;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: "absolute", left: 0, bottom: 0 }}>
      <defs>
        <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.12" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={paths.area} fill="url(#fill)" />
      <path d={paths.line} fill="none" stroke={color} strokeOpacity="0.3" strokeWidth={1.5 * s} strokeLinejoin="round" />
    </svg>
  );
}

function Card({ data, format, w, h, s }: { data: ShareCardData; format: ShareFormat; w: number; h: number; s: number }) {
  const up = (data.pnl ?? 0) >= 0;
  const pnlColor = data.pnl == null ? C.text : up ? C.positive : C.negative;
  const roiColor = data.roi == null ? C.text : data.roi >= 0 ? C.positive : C.negative;
  const pnl = sharePnl(data.pnl);
  const base = {
    position: "relative" as const,
    width: w,
    height: h,
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
    color: C.text,
    fontFamily: "Inter",
    backgroundColor: C.bg,
  };
  const divider = <div style={{ width: 1, height: 30 * s, background: C.border }} />;
  const period = (
    <div style={{ display: "flex", padding: `${3 * s}px ${8 * s}px`, borderRadius: 999, border: `1px solid ${C.border}`, fontSize: 10 * s, fontWeight: 600, color: C.muted }}>
      {periodLabel(data.period)}
    </div>
  );

  if (format === "portrait") {
    return (
      <div style={{ ...base, alignItems: "center", padding: `${36 * s}px ${32 * s}px` }}>
        <Dots w={w} h={h} s={s} />
        <Line data={data} w={w} h={h * 0.4} s={s} />
        <div style={{ position: "absolute", top: 18 * s, left: 18 * s, right: 18 * s, bottom: 18 * s, border: `1px solid rgba(255,122,69,0.4)`, borderRadius: 20 * s, display: "flex" }} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 15 * s }}>
          <Avatar data={data} size={116 * s} />
          <div style={{ fontSize: 31 * s, fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1, maxWidth: 416 * s, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{data.name}</div>
          {period}
        </div>
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontSize: heroSize(pnl, 64, 400) * s, fontWeight: 800, letterSpacing: "-0.04em", color: pnlColor, lineHeight: 1, whiteSpace: "nowrap" }}>{pnl}</div>
        </div>
        <div style={{ display: "flex", width: "100%", alignItems: "center", background: "rgba(255,122,69,0.08)", border: `1px solid ${C.border}`, borderRadius: 18 * s, padding: `${18 * s}px ${14 * s}px` }}>
          <div style={{ display: "flex", flex: 1, justifyContent: "center" }}>
            <Stat label="ROI" value={shareRoi(data.roi)} color={roiColor} s={s} big />
          </div>
          {divider}
          <div style={{ display: "flex", flex: 1, justifyContent: "center" }}>
            <Stat label="Win Rate" value={shareWinRate(data.winRate)} color={C.primary} s={s} big />
          </div>
        </div>
        <div style={{ display: "flex", width: "100%", paddingTop: 26 * s }}>
          <Footer s={s} />
        </div>
      </div>
    );
  }

  // CopyDog's 16:9 card: avatar and name, the PnL with ROI and win rate,
  // then the brand; no period chip and no PnL line behind it.
  return (
    <div style={{ ...base, justifyContent: "space-between", padding: `${34 * s}px ${38 * s}px` }}>
      <Dots w={w} h={h} s={s} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 17 * s }}>
        <div style={{ display: "flex", alignItems: "center", gap: 17 * s, minWidth: 0 }}>
          <Avatar data={data} size={70 * s} />
          <div style={{ fontSize: 30 * s, fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1, maxWidth: 380 * s, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{data.name}</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 25 * s }}>
        <div style={{ display: "flex", fontSize: heroSize(pnl, 58, 360) * s, fontWeight: 800, letterSpacing: "-0.04em", color: pnlColor, lineHeight: 1, whiteSpace: "nowrap" }}>{pnl}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 23 * s, paddingBottom: 3 * s, flexShrink: 0 }}>
          <Stat label="ROI" value={shareRoi(data.roi)} color={roiColor} s={s} />
          {divider}
          <Stat label="Win Rate" value={shareWinRate(data.winRate)} color={data.winRate == null ? C.text : C.positive} s={s} />
        </div>
      </div>
      <Footer s={s} />
    </div>
  );
}

/** The card as a PNG. `size` overrides the pixel size (the Open Graph
 * image's 1200 × 630); the design scales to its width. */
export async function renderShareCard(
  data: ShareCardData,
  format: ShareFormat,
  options: { size?: { width: number; height: number }; headers?: Record<string, string> } = {},
) {
  const design = SHARE_FORMATS[format];
  const width = options.size?.width ?? design.w * SHARE_SCALE;
  const s = width / design.w;
  const height = options.size?.height ?? design.h * SHARE_SCALE;
  return new ImageResponse(<Card data={data} format={format} w={width} h={height} s={s} />, {
    width,
    height,
    fonts: await loadFonts(),
    headers: options.headers,
  });
}
