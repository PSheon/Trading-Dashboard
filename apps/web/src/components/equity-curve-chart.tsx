"use client";

import { useMemo, useState } from "react";
import type { EquityPoint } from "@trading-dashboard/shared";

import { formatDateTime, formatUsd } from "@/lib/format";

const WIDTH = 640;
const HEIGHT = 200;
const PAD_X = 8;
const PAD_Y = 16;

/**
 * Minimal single-series line chart for the D3 equity curve (§4.5). No
 * charting library — a hand-rolled SVG per the task's "keep it simple"
 * guidance. Single series needs no legend (the card title names it); a 2px
 * rounded-cap line + a low-opacity area fill under it, with a hover
 * crosshair + tooltip (dataviz guidance: an SVG line chart ships hover by
 * default).
 */
export function EquityCurveChart({ points }: { points: EquityPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const series = useMemo(
    () =>
      points.map((p) => ({
        ts: typeof p.ts === "string" ? new Date(p.ts) : p.ts,
        value: Number(p.accountValue),
      })),
    [points],
  );

  const { path, areaPath, xForIndex, yForValue, min, max } = useMemo(() => {
    if (series.length === 0) {
      return { path: "", areaPath: "", xForIndex: () => 0, yForValue: () => 0, min: 0, max: 0 };
    }
    const values = series.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const innerW = WIDTH - PAD_X * 2;
    const innerH = HEIGHT - PAD_Y * 2;

    const xForIndex = (i: number) =>
      PAD_X + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
    const yForValue = (v: number) => PAD_Y + innerH - ((v - min) / range) * innerH;

    const linePoints = series.map((p, i) => `${xForIndex(i)},${yForValue(p.value)}`);
    const path = `M ${linePoints.join(" L ")}`;
    const areaPath = `${path} L ${xForIndex(series.length - 1)},${HEIGHT - PAD_Y} L ${xForIndex(0)},${HEIGHT - PAD_Y} Z`;

    return { path, areaPath, xForIndex, yForValue, min, max };
  }, [series]);

  if (series.length === 0) {
    return <p className="text-sm text-muted-foreground">No equity data yet.</p>;
  }

  const hovered = hoverIndex !== null ? series[hoverIndex] : null;

  function handlePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * WIDTH;
    const fraction = (x - PAD_X) / (WIDTH - PAD_X * 2);
    const idx = Math.round(fraction * (series.length - 1));
    setHoverIndex(Math.min(series.length - 1, Math.max(0, idx)));
  }

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <line
          x1={PAD_X}
          y1={HEIGHT - PAD_Y}
          x2={WIDTH - PAD_X}
          y2={HEIGHT - PAD_Y}
          className="stroke-border"
          strokeWidth={1}
        />
        <path d={areaPath} fill="var(--color-chart-1)" fillOpacity={0.12} stroke="none" />
        <path
          d={path}
          fill="none"
          stroke="var(--color-chart-1)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {hoverIndex !== null ? (
          <>
            <line
              x1={xForIndex(hoverIndex)}
              y1={PAD_Y}
              x2={xForIndex(hoverIndex)}
              y2={HEIGHT - PAD_Y}
              className="stroke-muted-foreground/40"
              strokeWidth={1}
            />
            <circle cx={xForIndex(hoverIndex)} cy={yForValue(series[hoverIndex].value)} r={3.5} fill="var(--color-chart-1)" />
          </>
        ) : null}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{formatUsd(min)}</span>
        <span>{formatUsd(max)}</span>
      </div>
      {hovered ? (
        <div className="absolute top-0 right-0 rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-sm">
          <div className="font-medium">{formatUsd(hovered.value)}</div>
          <div className="text-muted-foreground">{formatDateTime(hovered.ts)}</div>
        </div>
      ) : null}
    </div>
  );
}
