import { describe, expect, it } from "vitest";
import { historicalSimulation } from "@/components/dev/historical-simulation";

describe("historical ROI illustration", () => {
  it.each([0.25, -0.8, 0])("keeps principal and ending value consistent for ROI %s", (roi) => {
    const result = historicalSimulation(1000, roi, [10, 18, 30]);
    expect(result?.total).toBeCloseTo(1000 * (1 + roi));
    expect(result?.profit).toBeCloseTo(1000 * roi);
    expect(result?.series[0][1]).toBe(1000);
    expect(result?.series.at(-1)?.[1]).toBeCloseTo(result!.total);
  });
  it("does not turn missing ROI into a zero return", () => {
    expect(historicalSimulation(1000, null, [1, 2, 3])).toBeNull();
  });
  it("keeps results available when no illustrative curve can be drawn", () => {
    const result = historicalSimulation(1000, 0.2, [10, 10, 10]);
    expect(result?.total).toBe(1200);
    expect(result?.series).toEqual([]);
  });
  it("supports a zero initial amount", () => {
    expect(historicalSimulation(0, 0.2, [1, 2, 3])).toEqual({ total: 0, profit: 0, series: [[0, 0], [1, 0], [2, 0]] });
  });
});
