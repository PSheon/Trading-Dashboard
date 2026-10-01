import { describe, expect, it } from "vitest";

import { monotonePath, spanTicks, stepTicks } from "@/components/charts/area-chart";

describe("area chart", () => {
  it("labels the y axis as CopyDog does: low, high and three even steps between", () => {
    expect(spanTicks(-37_500, 341_300)).toEqual([-37_500, 57_200, 151_900, 246_600, 341_300]);
    expect(spanTicks(5, 5)).toEqual([5]);
    expect(spanTicks(Number.NaN, 1)).toEqual([]);
  });

  it("labels the desktop y axis in CopyDog's rounded steps below the high", () => {
    const r = (xs: number[]) => xs.map((x) => Math.round(x * 10) / 10);
    expect(r(stepTicks(-37_500, 341_300))).toEqual([-37_500, 57_500, 152_500, 341_300]);
    expect(r(stepTicks(0, 300_100))).toEqual([0, 80_000, 160_000, 300_100]);
    expect(r(stepTicks(-39.5, 14.4))).toEqual([-39.5, -24.5, -9.5, 14.4]);
    // Recharts keeps a step that is at least 0.99 of a step below the high.
    expect(r(stepTicks(-37_500, 342_100))).toEqual([-37_500, 57_500, 152_500, 247_500, 342_100]);
    // Below 10 the steps are whole units.
    expect(r(stepTicks(0, 29))).toEqual([0, 8, 16, 29]);
  });

  it("draws a smooth curve that passes through every point", () => {
    const d = monotonePath([[0, 10], [10, 0], [20, 5], [30, 5]]);
    expect(d.startsWith("M0.00,10.00")).toBe(true);
    expect(d.match(/C/g)).toHaveLength(3);
    expect(d.endsWith("30.00,5.00")).toBe(true);
    // Two points stay a straight line.
    expect(monotonePath([[0, 0], [5, 5]])).toBe("M0.00,0.00L5.00,5.00");
  });
});
