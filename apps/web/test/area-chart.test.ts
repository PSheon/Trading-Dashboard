import { describe, expect, it } from "vitest";

import { monotonePath, spanTicks } from "@/components/charts/area-chart";

describe("area chart", () => {
  it("labels the y axis as CopyDog does: low, high and three even steps between", () => {
    expect(spanTicks(-37_500, 341_300)).toEqual([-37_500, 57_200, 151_900, 246_600, 341_300]);
    expect(spanTicks(5, 5)).toEqual([5]);
    expect(spanTicks(Number.NaN, 1)).toEqual([]);
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
