import { describe, expect, it } from "vitest";

import { Dec, d } from "../src/common/decimal/dec.js";

/** A small deterministic generator (mulberry32), so a failure can be replayed from its seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const decimalString = (r: () => number, maxWhole = 1e9, dp = 8): string => {
  const whole = Math.floor(r() * maxWhole);
  const places = Math.floor(r() * (dp + 1));
  const fraction = places ? String(Math.floor(r() * 10 ** places)).padStart(places, "0") : "";
  return `${r() < 0.3 ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
};

describe("Dec", () => {
  it("does what floats don't: 0.1 + 0.2 is 0.3, and a thousand cents are ten dollars", () => {
    expect(d("0.1").add("0.2").toString()).toBe("0.3");
    expect(d(0.1).add(0.2).eq("0.3")).toBe(true);
    expect(0.1 + 0.2 === 0.3).toBe(false);
    let total = Dec.ZERO;
    for (let i = 0; i < 1000; i++) total = total.add("0.01");
    expect(total.toString()).toBe("10");
    expect(d("1.15").mul(100).toString()).toBe("115");
    expect(d("0.00045").mul("5002.5").toString()).toBe("2.251125");
  });

  it("parses Hyperliquid's strings, Postgres numerics and JSON numbers at face value", () => {
    expect(d("24513.75250433").toString()).toBe("24513.75250433");
    expect(d("-0.000001").toString()).toBe("-0.000001");
    expect(d("100050.00000000").toString()).toBe("100050");
    expect(d(4.5).toString()).toBe("4.5");
    expect(d(1e-7).toString()).toBe("0.0000001");
    expect(d(1.5e21).toString()).toBe("1500000000000000000000");
    expect(d(123456789012345680000).toString()).toBe("123456789012345680000");
    expect(d(7n).toString()).toBe("7");
    expect(d("+1.50").toString()).toBe("1.5");
    expect(d(".5").toString()).toBe("0.5");
    expect(d("2e-3").toString()).toBe("0.002");
    expect(d("-0").toString()).toBe("0");
    for (const bad of ["", "abc", "1.2.3", "0x10", null, undefined, Number.NaN, Infinity, {}]) expect(Dec.parse(bad), String(bad)).toBeNull();
    expect(() => Dec.from("abc")).toThrow(/Not a decimal/);
  });

  it("rounds half away from zero, truncates toward zero, and keeps significant figures", () => {
    expect(d("2.5").round(0).toString()).toBe("3");
    expect(d("-2.5").round(0).toString()).toBe("-3");
    expect(d("1.005").round(2).toString()).toBe("1.01"); // 1.005.toFixed(2) is "1.00"
    expect(d("0.123456785").round(8).toString()).toBe("0.12345679");
    expect(d("0.0499999999").floor(4).toString()).toBe("0.0499");
    expect(d("-1.999").floor(2).toString()).toBe("-1.99");
    expect(d("5").floor(0).toString()).toBe("5");
    expect(d("100050.4").toSignificant(5).toString()).toBe("100050");
    expect(d("80959.5").toSignificant(5).toString()).toBe("80960");
    expect(d("0.0100049").toSignificant(5).toString()).toBe("0.010005");
    expect(d("123.4").toSignificant(5).toString()).toBe("123.4");
    expect(d("12.5").toFixed(2)).toBe("12.50");
    expect(d("12.345").toFixed(0)).toBe("12");
    expect(d("7").isInteger).toBe(true);
    expect(d("7.1").isInteger).toBe(false);
  });

  it("divides to 18 decimals and says so; division by zero throws", () => {
    expect(d(1).div(3).toString()).toBe("0.333333333333333333");
    expect(d(2).div(3).toString()).toBe("0.666666666666666667");
    expect(d(-2).div(3).toString()).toBe("-0.666666666666666667");
    expect(d(1).div(3).mul(3).round(12).toString()).toBe("1");
    expect(() => d(1).div(0)).toThrow(RangeError);
  });

  it("compares, signs, picks extremes and sums", () => {
    expect(d("1.10").eq("1.1")).toBe(true);
    expect(d("1.1").gt("1.09")).toBe(true);
    expect(d("-0.1").lt(0)).toBe(true);
    expect([d("-1").sign, d("0").sign, d("0.000000000000000001").sign]).toEqual([-1, 0, 1]);
    expect(Dec.max(d(1), d("1.5"), d(-3)).toString()).toBe("1.5");
    expect(Dec.min(d(1), d("1.5"), d(-3)).toString()).toBe("-3");
    expect(Dec.sum([d("0.1"), d("0.2"), d("0.3")]).toString()).toBe("0.6");
    expect(JSON.stringify({ a: d("1.50") })).toBe('{"a":"1.5"}');
  });

  it("property: addition and subtraction are exact and order does not matter (2,000 random triples)", () => {
    const r = rng(20261003);
    for (let i = 0; i < 2000; i++) {
      const [a, b, c] = [decimalString(r), decimalString(r), decimalString(r)].map(d) as [Dec, Dec, Dec];
      expect(a.add(b).add(c).eq(c.add(a).add(b)), `${a} ${b} ${c}`).toBe(true);
      expect(a.add(b).sub(b).eq(a)).toBe(true);
      expect(a.sub(b).eq(b.sub(a).neg())).toBe(true);
      // The string round trip loses nothing.
      expect(d(a.toString()).eq(a)).toBe(true);
    }
  });

  it("property: a size × a price is exact, and distributes over a sum of sizes (2,000 random cases)", () => {
    const r = rng(77);
    for (let i = 0; i < 2000; i++) {
      const px = d(decimalString(r, 200_000, 6)).abs();
      const s1 = d(decimalString(r, 1_000, 8)).abs();
      const s2 = d(decimalString(r, 1_000, 8)).abs();
      // ≤ 8 + 6 decimals: nothing to round.
      expect(s1.add(s2).mul(px).eq(s1.mul(px).add(s2.mul(px))), `${s1} ${s2} ${px}`).toBe(true);
      expect(s1.mul(px).eq(px.mul(s1))).toBe(true);
    }
  });
});
