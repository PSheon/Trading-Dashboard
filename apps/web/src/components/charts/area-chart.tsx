"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";

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
  formatTime?: (time: number) => string;
  formatAxisTime?: (time: number) => string;
  /** Dotted line at zero (sparklines). */
  zeroLine?: boolean;
  strokeWidth?: number;
  className?: string;
  /** Rendered faintly in the middle of the plot (brand watermark). */
  watermark?: React.ReactNode;
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

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return [min];
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) ticks.push(v);
  return ticks;
}

export function AreaChart({
  data,
  height,
  zeroBaseline = true,
  interactive = false,
  axes = false,
  formatValue = (v) => v.toFixed(2),
  formatTime = (t) => new Date(t).toISOString(),
  formatAxisTime,
  zeroLine = false,
  strokeWidth = 2,
  className,
  watermark,
  ariaLabel,
}: AreaChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const uid = useId().replace(/:/g, "");

  const pad = axes
    ? { top: 16, right: 64, bottom: 28, left: 4 }
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
    const headroom = (maxY - minY) * (axes ? 0.08 : 0.04);
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

    const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(d[0]).toFixed(2)},${y(d[1]).toFixed(2)}`).join("");
    const area = `${line}L${x(maxX).toFixed(2)},${zeroY.toFixed(2)}L${x(minX).toFixed(2)},${zeroY.toFixed(2)}Z`;
    const yTicks = axes ? niceTicks(minY + headroom * 0.5, maxY - headroom * 0.5, 4) : [];
    const xTickCount = width < 420 ? 3 : 5;
    const xTicks = axes
      ? Array.from({ length: xTickCount }, (_, i) => minX + ((maxX - minX) * (i + 0.5)) / xTickCount)
      : [];
    return { x, y, line, area, zeroY, bottom, innerW, minX, maxX, yTicks, xTicks };
  }, [data, width, height, zeroBaseline, axes, pad.left, pad.right, pad.top, pad.bottom]);

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
  const hovered = hover !== null ? data[hover] : null;
  const ids = {
    above: `above-${uid}`,
    below: `below-${uid}`,
    gradUp: `grad-up-${uid}`,
    gradDown: `grad-down-${uid}`,
    hatchUp: `hatch-up-${uid}`,
    hatchDown: `hatch-down-${uid}`,
  };

  return (
    <div ref={ref} className={cn("relative w-full select-none", className)} style={{ height }}>
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

          {axes
            ? geo.yTicks.map((v) => (
                <g key={v}>
                  <line
                    x1={pad.left}
                    x2={width - pad.right + 6}
                    y1={geo.y(v)}
                    y2={geo.y(v)}
                    stroke="var(--border)"
                    strokeDasharray="2 4"
                  />
                  <text
                    x={width - pad.right + 10}
                    y={geo.y(v)}
                    dy="0.32em"
                    className="fill-subtle-foreground font-mono text-[10.5px]"
                  >
                    {formatValue(v)}
                  </text>
                </g>
              ))
            : null}
          {axes && formatAxisTime
            ? geo.xTicks.map((t) => (
                <text
                  key={t}
                  x={geo.x(t)}
                  y={height - 8}
                  textAnchor="middle"
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

          <g clipPath={`url(#${ids.above})`}>
            <path d={geo.area} fill={`url(#${ids.gradUp})`} />
            <path d={geo.area} fill={`url(#${ids.hatchUp})`} />
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
              <path d={geo.area} fill={`url(#${ids.gradDown})`} />
              <path d={geo.area} fill={`url(#${ids.hatchDown})`} />
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

          {last && hover === null ? (
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
