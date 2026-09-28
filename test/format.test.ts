import { describe, expect, it } from "vitest";

import { ago, num, pct, price, sol } from "../src/lib/format";

describe("format", () => {
  it("never prints negative zero", () => {
    expect([num(-0), sol(-0), pct(-0), num(-0.0001)]).toEqual(["0.000", "0.000", "0.0%", "0.000"]);
  });
  it("signs PnL and lines up prices", () => {
    expect([sol(1.5), sol(-2)]).toEqual(["+1.500", "-2.000"]);
    expect([price(0.5), price(0.00012345)]).toEqual(["0.500", "1.23e-4"]);
  });
  it("formats relative time against a given clock", () => {
    expect(ago(1000, 1000 + 7200)).toBe("2.0h ago");
  });
});
