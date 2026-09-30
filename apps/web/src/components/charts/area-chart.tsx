"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";
import styles from "./area-chart.module.css";

/**
 * Hand-rolled SVG area chart (no chart library: one series, a few hundred
 * points at most). One colour rule for every chart in the app:
 *
 *   the series is Orbie orange; wherever it dips below zero it turns red.
 *
 * Line + a soft gradient with a diagonal hatch underneath, a glowing end
 * dot, and (when `interactive`) a crosshair with a tooltip. Width follows
 * the container so strokes and labels stay crisp at any size.
 */
export type SeriesPoint = readonly [number, number];

export interface AreaChartProps {
  data: readonly SeriesPoint[];
  height: number;
  /** Fill down to zero and colour negative stretches red (PnL). When false
   * the area fills to the bottom (account value). */
  zeroBaseline?: boolean;
  interactive?: boolean;
  /** Right-hand y labels and bottom x labels. */
  axes?: boolean;
  formatValue?: (value: number) => string;
  /** Y-axis labels; defaults to `formatValue`. CopyDog's axes are unsigned
   * compact figures ("$6.9M", "-$403") while the tooltip keeps the sign. */
  formatTick?: (value: number) => string;
  formatTime?: (time: number) => string;
  formatAxisTime?: (time: number) => string;
  /** Dotted line at zero (sparklines). */
  zeroLine?: boolean;
  strokeWidth?: number;
  className?: string;
  /** Rendered faintly in the middle of the plot (brand watermark). */
  watermark?: React.ReactNode;
  /** CopyDog's card charts: this many faint dotted lines, evenly spaced
   * from the top of the plot to the bottom. */
  grid?: number;
  /** Where the y labels sit: CopyDog's desktop chart keeps them in a right
   * gutter, its phone chart draws them over the plot's left edge. */
  yAxis?: "right" | "left";
  /** A marker driven from outside (the home calculator): a dashed vertical
   * line and a dot on that point, with no tooltip. */
  marker?: number | null;
  ariaLabel?: string;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** CopyDog's y labels: the series' low and high and three evenly spaced
 * values between them ("$341K $247K $152K $57K -$38K"). */
export function spanTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max <= min) return [min];
  return Array.from({ length: count }, (_, i) => min + ((max - min) * i) / (count - 1));
}

/** CopyDog's desktop y labels: the low, then steps of about a quarter of the
 * range (rounded up to a multiple of 5 in the second digit: 94.7K → 95K,
 * 75K → 80K), dropping any step closer than one step to the high, then the
 * high ("-$37.5K $57.5K $152.5K $341.3K"). */
export function stepTicks(min: number, max: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max <= min) return [min];
  const raw = (max - min) / 4;
  const unit = 5 * 10 ** (Math.floor(Math.log10(raw)) - 1);
  const step = Math.ceil(raw / unit - 1e-9) * unit;
  const ticks = [min];
  for (let v = min + step; v <= max - step + step * 1e-9; v += step) ticks.push(v);
  ticks.push(max);
  return ticks;
}

/** A monotone cubic path through the points (d3's curveMonotoneX): smooth
 * like CopyDog's curves, never overshooting a high or a low. */
export function monotonePath(points: ReadonlyArray<readonly [number, number]>): string {
  const n = points.length;
  if (n === 0) return "";
  const f = (v: number) => v.toFixed(2);
  if (n < 3) return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${f(x)},${f(y)}`).join("");
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1][0] - points[i][0]);
    m.push(dx[i] === 0 ? 0 : (points[i + 1][1] - points[i][1]) / dx[i]);
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) t.push(0);
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      t.push((w1 + w2) / (w1 / m[i - 1] + w2 / m[i]));
    }
  }
  t.push(m[n - 2]);
  let d = `M${f(points[0][0])},${f(points[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const h = dx[i] / 3;
    d += `C${f(x0 + h)},${f(y0 + h * t[i])},${f(x1 - h)},${f(y1 - h * t[i + 1])},${f(x1)},${f(y1)}`;
  }
  return d;
}

export function AreaChart({
  data,
  height,
  zeroBaseline = true,
  interactive = false,
  axes = false,
  formatValue = (v) => v.toFixed(2),
  formatTick,
  formatTime = (t) => new Date(t).toISOString(),
  formatAxisTime,
  zeroLine = false,
  strokeWidth = 2,
  className,
  watermark,
  grid = 0,
  yAxis = "right",
  marker = null,
  ariaLabel,
}: AreaChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const uid = useId().replace(/:/g, "");
  const hasData = data.length > 0;

  // Start once the chart is visible, including charts below the fold or
  // inside a horizontal carousel. Hover and data refreshes never replay it.
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasData || revealed) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0)) {
        setRevealed(true);
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, hasData, revealed]);

  const pad = axes
    ? { top: 12, right: yAxis === "right" ? 64 : 6, bottom: 28, left: 4 }
    : { top: strokeWidth * 3 + 2, right: 6, bottom: 3, left: 2 };

  const geo = useMemo(() => {
    if (data.length === 0 || width === 0) return null;
    const xs = data.map((d) => d[0]);
    const ys = data.map((d) => d[1]);
    let minY = Math.min(...ys);
    let maxY = Math.max(...ys);
    if (zeroBaseline) {
      minY = Math.min(minY, 0);
      maxY = Math.max(maxY, 0);
    }
    if (minY === maxY) {
      minY -= 1;
      maxY += 1;
    }
    const low = minY;
    const high = maxY;
    const headroom = (maxY - minY) * 0.04;
    maxY += headroom;
    if (!zeroBaseline || minY < 0) minY -= headroom;

    const minX = xs[0];
    const maxX = xs[xs.length - 1];
    const innerW = Math.max(1, width - pad.left - pad.right);
    const innerH = Math.max(1, height - pad.top - pad.bottom);
    const x = (t: number) => pad.left + (maxX === minX ? innerW / 2 : ((t - minX) / (maxX - minX)) * innerW);
    const y = (v: number) => pad.top + (1 - (v - minY) / (maxY - minY)) * innerH;
    const bottom = pad.top + innerH;
    const zeroY = zeroBaseline ? Math.min(bottom, Math.max(pad.top, y(0))) : bottom;

    const line = monotonePath(data.map((d) => [x(d[0]), y(d[1])] as const));
    const area = `${line}L${x(maxX).toFixed(2)},${zeroY.toFixed(2)}L${x(minX).toFixed(2)},${zeroY.toFixed(2)}Z`;
    const lo = zeroBaseline ? Math.min(...ys) : low;
    const hi = zeroBaseline ? Math.max(...ys) : high;
    // Phones label five even steps; the desktop chart uses CopyDog's steps.
    const yTicks = axes ? (yAxis === "left" ? spanTicks(lo, hi) : stepTicks(lo, hi)) : [];
    // CopyDog's x labels: evenly spaced, the last one pinned to the end.
    const xTickCount = width < 420 ? 3 : 5;
    const xTicks = axes
      ? Array.from({ length: xTickCount }, (_, i) => (i === xTickCount - 1 ? maxX : minX + ((maxX - minX) * (i + 1)) / (xTickCount + 0.5)))
      : [];
    return { x, y, line, area, zeroY, bottom, innerW, minX, maxX, yTicks, xTicks };
  }, [data, width, height, zeroBaseline, axes, yAxis, pad.left, pad.right, pad.top, pad.bottom]);

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!geo || !interactive) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = geo.minX + ((px - pad.left) / geo.innerW) * (geo.maxX - geo.minX);
    let best = 0;
    let bestDist = Infinity;
    data.forEach((d, i) => {
      const dist = Math.abs(d[0] - t);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    setHover(best);
  }

  const last = data[data.length - 1];
  const markerPoint = marker !== null && marker >= 0 && marker < data.length ? data[marker] : null;
  const hovered = hover !== null ? data[hover] : null;
  const ids = {
    above: `above-${uid}`,
    below: `below-${uid}`,
    gradUp: `grad-up-${uid}`,
    gradDown: `grad-down-${uid}`,
    hatchUp: `hatch-up-${uid}`,
    hatchDown: `hatch-down-${uid}`,
    reveal: `reveal-${uid}`,
  };

  return (
    <div ref={ref} data-revealed={revealed} className={cn(styles.chart, "relative w-full select-none", className)} style={{ height }}>
      {geo ? (
        <svg
          width={width}
          height={height}
          className="block overflow-visible"
          role={ariaLabel ? "img" : undefined}
          aria-hidden={!ariaLabel}
          aria-label={ariaLabel}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <clipPath id={ids.reveal}>
              <rect className={styles.reveal} x={-20} y={-20} width={width + 40} height={height + 40} />
            </clipPath>
            <clipPath id={ids.above}>
              <rect x={0} y={-20} width={width} height={Math.max(0, geo.zeroY + 20)} />
            </clipPath>
            <clipPath id={ids.below}>
              <rect x={0} y={geo.zeroY} width={width} height={Math.max(0, height - geo.zeroY + 20)} />
            </clipPath>
            <linearGradient id={ids.gradUp} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.32} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id={ids.gradDown} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.32} />
              <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.02} />
            </linearGradient>
            <pattern id={ids.hatchUp} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={5} stroke="var(--chart-1)" strokeOpacity={0.22} strokeWidth={1} />
            </pattern>
            <pattern id={ids.hatchDown} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={5} stroke="var(--chart-2)" strokeOpacity={0.22} strokeWidth={1} />
            </pattern>
          </defs>

          {grid > 0
            ? Array.from({ length: grid }, (_, i) => pad.top + ((height - pad.top - pad.bottom) * i) / Math.max(1, grid - 1)).map((gy) => (
                <line key={gy} x1={0} x2={width} y1={gy} y2={gy} stroke="var(--border-strong)" strokeOpacity={0.6} strokeDasharray="1.5 3" />
              ))
            : null}
          {axes
            ? geo.yTicks.map((v, i) => (
                <text
                  key={i}
                  x={yAxis === "right" ? width - pad.right + 10 : pad.left + 2}
                  y={geo.y(v)}
                  dy={yAxis === "right" ? "0.32em" : i === geo.yTicks.length - 1 ? "0.9em" : "-0.35em"}
                  className="fill-subtle-foreground font-mono text-[10.5px]"
                >
                  {(formatTick ?? formatValue)(v)}
                </text>
              ))
            : null}
          {axes && formatAxisTime
            ? geo.xTicks.map((t, i) => (
                <text
                  key={t}
                  x={geo.x(t)}
                  y={height - 8}
                  textAnchor={i === geo.xTicks.length - 1 ? "end" : "middle"}
                  className="fill-subtle-foreground font-mono text-[10.5px]"
                >
                  {formatAxisTime(t)}
                </text>
              ))
            : null}

          {watermark ? (
            <foreignObject x={pad.left} y={pad.top} width={geo.innerW} height={height - pad.top - pad.bottom}>
              <div className="pointer-events-none flex h-full w-full items-center justify-center opacity-[0.06]">
                {watermark}
              </div>
            </foreignObject>
          ) : null}

          {zeroLine && zeroBaseline && geo.zeroY < geo.bottom - 1 ? (
            <line
              x1={0}
              x2={width}
              y1={geo.zeroY}
              y2={geo.zeroY}
              stroke="var(--border-strong)"
              strokeDasharray="1.5 3"
            />
          ) : null}

          <g clipPath={`url(#${ids.reveal})`}>
          <g clipPath={`url(#${ids.above})`}>
            <path className={styles.fill} d={geo.area} fill={`url(#${ids.gradUp})`} />
            <path className={styles.fill} d={geo.area} fill={`url(#${ids.hatchUp})`} />
            <path
              d={geo.line}
              fill="none"
              stroke="var(--chart-1)"
              strokeWidth={strokeWidth}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
          {zeroBaseline ? (
            <g clipPath={`url(#${ids.below})`}>
              <path className={styles.fill} d={geo.area} fill={`url(#${ids.gradDown})`} />
              <path className={styles.fill} d={geo.area} fill={`url(#${ids.hatchDown})`} />
              <path
                d={geo.line}
                fill="none"
                stroke="var(--chart-2)"
                strokeWidth={strokeWidth}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          ) : null}

          {last && hover === null && !markerPoint ? (
            <g>
              <circle
                cx={geo.x(last[0])}
                cy={geo.y(last[1])}
                r={strokeWidth * 3.2}
                fill={last[1] < 0 && zeroBaseline ? "var(--chart-2)" : "var(--chart-1)"}
                opacity={0.22}
              />
              <circle
                cx={geo.x(last[0])}
                cy={geo.y(last[1])}
                r={strokeWidth * 1.6}
                fill={last[1] < 0 && zeroBaseline ? "var(--chart-2)" : "var(--chart-1)"}
              />
            </g>
          ) : null}

          </g>

          {markerPoint ? (
            <g>
              <line
                x1={geo.x(markerPoint[0])}
                x2={geo.x(markerPoint[0])}
                y1={0}
                y2={height}
                stroke="var(--muted-foreground)"
                strokeOpacity={0.7}
                strokeDasharray="3 3"
              />
              <circle cx={geo.x(markerPoint[0])} cy={geo.y(markerPoint[1])} r={strokeWidth * 1.8} fill={markerPoint[1] < 0 && zeroBaseline ? "var(--chart-2)" : "var(--chart-1)"} />
            </g>
          ) : null}

          {hovered ? (
            <g>
              <line
                x1={geo.x(hovered[0])}
                x2={geo.x(hovered[0])}
                y1={pad.top}
                y2={geo.bottom}
                stroke="var(--muted-foreground)"
                strokeOpacity={0.5}
                strokeDasharray="3 3"
              />
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={geo.y(hovered[1])}
                y2={geo.y(hovered[1])}
                stroke="var(--muted-foreground)"
                strokeOpacity={0.25}
                strokeDasharray="3 3"
              />
              <circle
                cx={geo.x(hovered[0])}
                cy={geo.y(hovered[1])}
                r={4.5}
                fill="var(--background)"
                stroke={hovered[1] < 0 && zeroBaseline ? "var(--chart-2)" : "var(--chart-1)"}
                strokeWidth={2}
              />
            </g>
          ) : null}
        </svg>
      ) : null}

      {geo && hovered ? (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-xl border border-border-strong bg-popover/95 px-3 py-2 shadow-xl shadow-black/40 backdrop-blur"
          style={
            geo.x(hovered[0]) > width / 2
              ? { right: width - geo.x(hovered[0]) + 12 }
              : { left: geo.x(hovered[0]) + 12 }
          }
        >
          <div className="num text-sm font-semibold text-foreground">{formatValue(hovered[1])}</div>
          <div className="num mt-0.5 text-[11px] text-muted-foreground">{formatTime(hovered[0])}</div>
        </div>
      ) : null}
    </div>
  );
}
