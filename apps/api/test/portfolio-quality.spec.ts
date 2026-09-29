import { describe, expect, it } from "vitest";
import { portfolioMetrics } from "../src/traders/traders.mappers.js";
const day = 86400000;
describe("portfolio methodology disclosure", () => {
  it("discloses excluded intervals without silently presenting complete coverage", () => {
    const result = portfolioMetrics([[0, 0], [day, 10], [2 * day, 20], [3 * day, 30]], {
      accountValue: [[0, 10], [day, 20], [2 * day, 10000], [3 * day, 10010]],
      pnl: [[0, 0], [day, 10], [2 * day, 20], [3 * day, 30]],
    });
    expect(result.methodology).toMatchObject({ version: "flow-neutral-v1", intervals: 3, excludedIntervals: 1, quality: "partial" });
    expect(result.methodology?.capitalFloorUsd).toBeCloseTo(100.1);
    expect(result.methodology?.excludedFraction).toBeCloseTo(1 / 3);
  });
  it("distinguishes no usable history from an observed flat return", () => {
    expect(portfolioMetrics([], { accountValue: [], pnl: [] }).methodology).toMatchObject({ quality: "unavailable", intervals: 0, excludedFraction: null });
    expect(portfolioMetrics([[0, 0], [day, 0]], { accountValue: [[0, 1000], [day, 1000]], pnl: [[0, 0], [day, 0]] }).methodology).toMatchObject({ quality: "observed", excludedIntervals: 0 });
  });
});
