// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AreaChart, LEFT_AXIS_GUTTER } from "@/components/charts/area-chart";

/** The phone chart at 390px: its box is 358px wide (the hero card's padding). */
const WIDTH = 358;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: WIDTH, height: 180, top: 0, left: 0, right: WIDTH, bottom: 180, x: 0, y: 0, toJSON() {} } as DOMRect);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const day = 86_400_000;
const series: [number, number][] = Array.from({ length: 30 }, (_, i) => [Date.UTC(2026, 8, 1) + i * day, i === 0 ? -595_000 : -595_000 + i * 360_000]);
const usd = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v) >= 1e6 ? `${(Math.abs(v) / 1e6).toFixed(0)}M` : `${(Math.abs(v) / 1e3).toFixed(0)}K`}`;

/** 2026-10-23, trader page at 390px: the y labels ($10M … -$595K) were drawn
 * at x=6 over the plot, and the line's start ran through them. The phone
 * chart now keeps a left gutter for them, as the desktop chart keeps a
 * right one. */
it("keeps the phone chart's y labels in a left gutter, the plot starting after them", async () => {
  await act(async () => root.render(<AreaChart data={series} height={180} axes interactive zeroBaseline yAxis="left" formatValue={usd} formatTick={usd} formatAxisTime={() => "x"} />));
  const labels = [...host.querySelectorAll<SVGTextElement>('text[data-axis="y"]')];
  expect(labels.length).toBeGreaterThanOrEqual(5);
  expect(labels.map((l) => l.textContent)).toContain("-$595K");
  for (const label of labels) {
    // Right-aligned inside the gutter, ending before the plot.
    expect(label.getAttribute("text-anchor")).toBe("end");
    expect(Number(label.getAttribute("x"))).toBeLessThanOrEqual(LEFT_AXIS_GUTTER - 8);
  }
  expect(LEFT_AXIS_GUTTER).toBeGreaterThanOrEqual(44);
  // The area and the line start at the gutter's edge, not at the chart's.
  const starts = [...host.querySelectorAll<SVGPathElement>("path[d^='M']")].map((p) => Number(/^M(-?[\d.]+)/.exec(p.getAttribute("d")!)![1]));
  expect(starts.length).toBeGreaterThan(0);
  for (const x of starts) expect(x).toBeGreaterThanOrEqual(LEFT_AXIS_GUTTER);
});

it("leaves the desktop chart's right gutter as it was", async () => {
  await act(async () => root.render(<AreaChart data={series} height={300} axes interactive zeroBaseline formatValue={usd} formatTick={usd} formatAxisTime={() => "x"} />));
  const labels = [...host.querySelectorAll<SVGTextElement>('text[data-axis="y"]')];
  expect(labels.length).toBeGreaterThanOrEqual(4);
  for (const label of labels) {
    expect(label.getAttribute("text-anchor")).toBeNull();
    expect(Number(label.getAttribute("x"))).toBe(WIDTH - 64 + 10);
  }
  const starts = [...host.querySelectorAll<SVGPathElement>("path[d^='M']")].map((p) => Number(/^M(-?[\d.]+)/.exec(p.getAttribute("d")!)![1]));
  for (const x of starts) expect(x).toBe(4);
});
