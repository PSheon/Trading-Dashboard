"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "cn";

import { Skeleton } from "@/components/page";
import { TIME_ZONE } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import type { CohortWindow } from "@/lib/contracts";
import { sentiment } from "./sentiment";

const PAD = { l: 12, r: 52, t: 14, b: 30 };
export const WINDOWS: CohortWindow[] = ["7d", "30d", "90d", "all"];

interface Pt { x: number; y: number }

/** Monotone cubic path through the points (CopyDog's chart curve). */
function smooth(points: Pt[]): string {
  const n = points.length;
  if (n < 2) return "";
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1].x - points[i].x || 1e-6;
    m[i] = (points[i + 1].y - points[i].y) / dx[i];
  }
  const tan = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) tan[i] = 0;
    else {
      const a = 2 * dx[i] + dx[i - 1];
      const b = dx[i] + 2 * dx[i - 1];
      tan[i] = (a + b) / (a / m[i - 1] + b / m[i]);
    }
  }
  tan[n - 1] = m[n - 2];
  let d = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${(points[i].x + h).toFixed(2)},${(points[i].y + tan[i] * h).toFixed(2)},${(points[i + 1].x - h).toFixed(2)},${(points[i + 1].y - tan[i + 1] * h).toFixed(2)},${points[i + 1].x.toFixed(2)},${points[i + 1].y.toFixed(2)}`;
  }
  return d;
}

/**
 * 倉位傾向 (CopyDog's cohort chart): the tier's long share over time as an
 * area — long below the line in green, short above it in red, the line
 * green above 50% and red below — BTC's price over it in grey on its own
 * scale, a 7D / 30D / 90D / ALL switch, and a hover readout.
 */
export function PositioningChart({ title, series, btc, window, onWindow, loading, latest, emptyHint }: {
  title: string;
  series: Array<{ t: string; pctLong: number; membershipVersion?: string | null; membershipChanged?: boolean }>;
  btc: Array<[number, number]>;
  window: CohortWindow;
  onWindow: (w: CohortWindow) => void;
  loading: boolean;
  /** The current long share when the history has fewer than two points. */
  latest: number | null;
  emptyHint: string;
}) {
  const { t, locale } = useI18n();
  const id = useId().replace(/:/g, "");
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 700, h: 330 });
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const points = useMemo(() => series.map((p, i) => ({ x: Date.parse(p.t), y: p.pctLong,
    boundary: i > 0 && (p.membershipChanged === true || (p.membershipVersion ?? null) !== (series[i - 1].membershipVersion ?? null)),
  })), [series]);
  const day = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: TIME_ZONE }), [locale]);
  const stamp = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TIME_ZONE }), [locale]);

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const iw = size.w - PAD.l - PAD.r;
    const ih = size.h - PAD.t - PAD.b;
    if (iw < 40 || ih < 40) return null;
    const x0 = points[0].x;
    const x1 = points[points.length - 1].x;
    const sx = (v: number) => PAD.l + ((v - x0) / Math.max(1, x1 - x0)) * iw;
    const sy = (v: number) => PAD.t + (1 - v / 100) * ih;
    const segments: Pt[][] = [];
    for (const p of points) {
      if (segments.length === 0 || p.boundary) segments.push([]);
      segments[segments.length - 1].push({ x: sx(p.x), y: sy(p.y) });
    }
    const paths = segments.filter(segment => segment.length >= 2).map(segment => {
      const line = smooth(segment);
      const left = segment[0].x.toFixed(2);
      const right = segment[segment.length - 1].x.toFixed(2);
      return { line, long: `${line}L${right},${(PAD.t + ih).toFixed(2)}L${left},${(PAD.t + ih).toFixed(2)}Z`,
        short: `${line}L${right},${PAD.t.toFixed(2)}L${left},${PAD.t.toFixed(2)}Z` };
    });
    const line = paths.map(path => path.line).join("");
    const long = paths.map(path => path.long).join("");
    const short = paths.map(path => path.short).join("");
    const isolated = segments.filter(segment => segment.length === 1).map(segment => segment[0]);
    const ticks: Array<{ px: number; label: string; i: number }> = [];
    let prev = "";
    for (let i = 0; i < 5; i++) {
      const v = x0 + ((x1 - x0) * i) / 4;
      const label = day.format(new Date(v));
      if (label !== prev) ticks.push({ px: sx(v), label, i });
      prev = label;
    }
    const inRange = btc.filter(([x]) => x >= x0 - 86_400_000 && x <= x1 + 86_400_000);
    let btcLine: string | null = null;
    if (inRange.length >= 2) {
      const lo = Math.min(...inRange.map((b) => b[1]));
      const hi = Math.max(...inRange.map((b) => b[1]));
      const pad = (hi - lo) * 0.08 || 1;
      const by = (v: number) => PAD.t + (1 - (v - lo + pad) / (hi - lo + pad * 2)) * ih;
      btcLine = smooth(inRange.map(([x, v]) => ({ x: sx(Math.min(Math.max(x, x0), x1)), y: by(v) })));
    }
    return { sx, sy, line, long, short, isolated, ticks, ih, mid: sy(50), btcLine, inRange };
  }, [points, btc, size, day]);

  const last = points.length ? points[points.length - 1] : null;
  const shown = hover !== null && points[hover] ? points[hover] : last;
  const value = shown?.y ?? latest;
  const tone = sentiment(value);
  const btcAt = useMemo(() => {
    if (!geo || geo.inRange.length === 0 || !shown) return null;
    let best = geo.inRange[0];
    for (const b of geo.inRange) if (Math.abs(b[0] - shown.x) < Math.abs(best[0] - shown.x)) best = b;
    return best[1];
  }, [geo, shown]);

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!geo) return;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(geo.sx(p.x) - x) < Math.abs(geo.sx(points[best].x) - x)) best = i;
    });
    setHover(best);
  }

  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-border bg-card">
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-border px-3">
        <h2 className="truncate text-[13px] font-semibold tracking-[-0.12px]">{title}</h2>
        <div className="flex items-center gap-3" role="radiogroup" aria-label={title}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={window === w}
              onClick={() => onWindow(w)}
              className={cn(
                "num rounded font-mono text-[11px] leading-[16.5px] font-medium tracking-[0.2px] uppercase outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                window === w ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {w}
            </button>
          ))}
        </div>
      </div>
      {shown ? <p className="px-3 pt-2 text-[11px] text-muted-foreground">{t("copyUpdates.historical")} · <time dateTime={new Date(shown.x).toISOString()}>{stamp.format(new Date(shown.x))}</time></p> : null}
      {points.some(point => point.boundary) ? <p className="px-3 pt-1 text-[11px] text-muted-foreground">{t("insights.cohort.membershipChanged")}</p> : null}
      <div ref={box} className="relative h-[400px]">
        {loading && !geo ? <Skeleton className="absolute inset-0" /> : null}
        {geo ? (
          <svg width={size.w} height={size.h} className="absolute inset-0" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={title}>
            <defs>
              <pattern id={`${id}-l`} width="4" height="4" patternUnits="userSpaceOnUse">
                <rect width="4" height="4" fill="rgb(52 211 153 / 16%)" />
                <line x1="0" y1="4" x2="4" y2="0" stroke="rgb(52 211 153 / 30%)" strokeWidth="1" />
              </pattern>
              <pattern id={`${id}-s`} width="4" height="4" patternUnits="userSpaceOnUse">
                <rect width="4" height="4" fill="rgb(244 80 111 / 14%)" />
                <line x1="0" y1="4" x2="4" y2="0" stroke="rgb(244 80 111 / 26%)" strokeWidth="1" />
              </pattern>
              <clipPath id={`${id}-above`}><rect x="0" y="0" width={size.w} height={geo.mid} /></clipPath>
              <clipPath id={`${id}-below`}><rect x="0" y={geo.mid} width={size.w} height={size.h - geo.mid} /></clipPath>
            </defs>
            <path d={geo.long} fill={`url(#${id}-l)`} />
            <path d={geo.short} fill={`url(#${id}-s)`} />
            <path d={geo.line} fill="none" strokeWidth="2" stroke="var(--positive)" clipPath={`url(#${id}-above)`} strokeLinejoin="round" />
            <path d={geo.line} fill="none" strokeWidth="2" stroke="var(--negative)" clipPath={`url(#${id}-below)`} strokeLinejoin="round" />
            {geo.isolated.map((point, i) => <circle key={i} cx={point.x} cy={point.y} r="3" fill="var(--foreground)" />)}
            {geo.btcLine ? <path d={geo.btcLine} fill="none" strokeWidth="1.4" stroke="var(--foreground)" strokeOpacity="0.45" strokeLinejoin="round" /> : null}
            {[0, 25, 50, 75, 100].map((v) => (
              <text key={v} x={size.w - PAD.r + 14} y={geo.sy(v) + 4} className="num fill-subtle-foreground font-mono text-[10px]">{v}%</text>
            ))}
            {geo.ticks.map((tick) => (
              <text key={tick.i} x={tick.px} y={size.h - 8} textAnchor={tick.i === 0 ? "start" : tick.i === 4 ? "end" : "middle"} className="fill-subtle-foreground text-[10px]">{tick.label}</text>
            ))}
            {shown ? (
              <>
                {hover !== null ? <line x1={geo.sx(shown.x)} x2={geo.sx(shown.x)} y1={PAD.t} y2={PAD.t + geo.ih} stroke="var(--muted-foreground)" strokeOpacity="0.55" strokeDasharray="3 3" /> : null}
                <circle cx={geo.sx(shown.x)} cy={geo.sy(shown.y)} r="3.5" fill={shown.y >= 50 ? "var(--positive)" : "var(--negative)"} stroke="var(--card)" strokeWidth="1.5" />
              </>
            ) : null}
          </svg>
        ) : !loading ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-raised/40 px-6 text-center text-sm text-muted-foreground">{emptyHint}</div>
        ) : null}
        {value !== null && value !== undefined ? (
          // CopyDog's .hl-cohort-chart__badge, 12px in from the plot's corner.
          // Both lines sit on the card's colour, so a curve that climbs
          // into the corner passes behind the figure instead of through it.
          <div className="pointer-events-none absolute top-[13px] left-3 flex flex-col items-start gap-[3px]">
            <div className="rounded-[3px] bg-card/90 py-[3px] pr-2 pl-1 font-mono text-[10px] leading-[15px] tracking-[0.4px] text-muted-foreground uppercase">
              {window} - {t(`insights.cohort.sentiment.${tone.key}`)}
            </div>
            <div className={cn("num rounded-[3px] bg-card/90 pr-2 pl-1 text-[19px] leading-[28.5px] font-semibold tracking-[-0.3px]", tone.dir > 0 ? "text-positive" : tone.dir < 0 ? "text-negative" : "text-foreground")}>
              {value.toFixed(1)}% {t("insights.cohort.long")}
            </div>
          </div>
        ) : null}
        {geo && (btcAt !== null || hover !== null) ? (
          <div className="pointer-events-none absolute top-[13px] right-14 flex flex-col items-end gap-0.5 font-mono text-[10.5px] leading-[15.75px] text-subtle-foreground">
            {btcAt !== null ? <span>— BTC ${Math.round(btcAt).toLocaleString("en-US")}</span> : null}
            {hover !== null && shown ? <span>{stamp.format(new Date(shown.x))}</span> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
