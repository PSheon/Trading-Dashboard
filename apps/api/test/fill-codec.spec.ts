import { describe, expect, it } from "vitest";

import { canonicalJson, decodeFill, encodeFill, FillEncodeError, sameFill, TWAP_ID_ABSENT } from "../src/analytics/fill-codec.js";
import type { HlUserFill } from "../src/hyperliquid/types.js";
import { ALL_SHAPES, CANONICAL_DECIMALS, ODD_DECIMALS, SEEN_SHAPES, UNSEEN_SHAPES } from "./fill-shapes.js";

const as = (value: Record<string, unknown>) => value as unknown as HlUserFill;

describe("fill codec: typed columns hold a fill exactly", () => {
  it.each(ALL_SHAPES.map((fill) => [fill.tid, fill] as const))("fill %s decodes to the object that was encoded", (_tid, fill) => {
    const decoded = decodeFill(encodeFill(fill));
    expect(canonicalJson(decoded)).toBe(canonicalJson(fill));
    // Not only as JSON text: the same keys, own and enumerable.
    expect(Object.keys(decoded).sort()).toEqual(Object.keys(fill).sort());
  });

  it("every shape Hyperliquid sends today fits the columns: nothing overflows", () => {
    for (const fill of SEEN_SHAPES) expect(encodeFill(fill).extra, String(fill.tid)).toBeNull();
  });

  it("a plain decimal string is a numeric as written; any other spelling is kept as text in extra", () => {
    for (const value of CANONICAL_DECIMALS) {
      const columns = encodeFill(as({ tid: 1, time: 1, px: value }));
      expect([columns.px, columns.extra], value).toEqual([value, null]);
    }
    for (const value of ODD_DECIMALS) {
      const columns = encodeFill(as({ tid: 1, time: 1, px: value }));
      expect([columns.px, columns.extra], JSON.stringify(value)).toEqual([null, { px: value }]);
    }
    // A number is not a decimal string.
    expect(encodeFill(as({ tid: 1, time: 1, px: 1.5 }))).toMatchObject({ px: null, extra: { px: 1.5 } });
  });

  it("twapId keeps three states apart: a number, null and no key", () => {
    expect(encodeFill(as({ tid: 1, time: 1, twapId: 7 })).twapId).toBe(7);
    expect(encodeFill(as({ tid: 1, time: 1, twapId: null })).twapId).toBeNull();
    expect(encodeFill(as({ tid: 1, time: 1 })).twapId).toBe(TWAP_ID_ABSENT);
    expect("twapId" in decodeFill(encodeFill(as({ tid: 1, time: 1 })))).toBe(false);
    expect(decodeFill(encodeFill(as({ tid: 1, time: 1, twapId: null }))).twapId).toBeNull();
    // The sentinel itself, sent as a value, is not mistaken for "no key".
    expect(decodeFill(encodeFill(as({ tid: 1, time: 1, twapId: -1 }))).twapId).toBe(-1);
  });

  it("the all-zero hash of a TWAP slice costs no bytes and still reads back in full", () => {
    const zero = `0x${"0".repeat(64)}`;
    const columns = encodeFill(as({ tid: 1, time: 1, hash: zero }));
    expect(columns.hash).toEqual(Buffer.alloc(0));
    expect(decodeFill(columns).hash).toBe(zero);
    expect(encodeFill(as({ tid: 1, time: 1, hash: `0x${"0f".repeat(32)}` })).hash).toHaveLength(32);
  });

  it("a fill with an unexpected key round-trips, whatever the key holds", () => {
    const fill = as({ tid: 9, time: 9, coin: "BTC", surprise: { deep: [1, { two: "2" }], none: null }, another: "0.10" });
    const columns = encodeFill(fill);
    expect(columns.extra).toEqual({ surprise: { deep: [1, { two: "2" }], none: null }, another: "0.10" });
    expect(sameFill(decodeFill(columns), fill)).toBe(true);
  });

  it("a key named __proto__ is data, not a prototype", () => {
    const fill = UNSEEN_SHAPES.find((entry) => entry.tid === 109)!;
    const decoded = decodeFill(encodeFill(fill)) as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(decoded, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("a fill that cannot key a row is refused, not stored under a guess", () => {
    for (const bad of [{ time: 1 }, { tid: 1 }, { tid: -1, time: 1 }, { tid: 1.5, time: 1 }, { tid: NaN, time: 1 }, { tid: 2 ** 53, time: 1 },
      { tid: "1", time: 1 }, { tid: 1, time: "1" }, { tid: 1, time: 1.5 }, { tid: 1, time: 9e15 }]) {
      expect(() => encodeFill(as(bad)), JSON.stringify(bad)).toThrow(FillEncodeError);
    }
  });

  it("sameFill compares by value: key order is free, a changed digit is not", () => {
    expect(sameFill({ a: "1.0", b: { c: 1, d: [1, 2] } }, { b: { d: [1, 2], c: 1 }, a: "1.0" })).toBe(true);
    expect(sameFill({ a: "1.0" }, { a: "1.00" })).toBe(false);
    expect(sameFill({ a: "1" }, { a: 1 })).toBe(false);
    expect(sameFill({ a: null }, {})).toBe(false);
    expect(sameFill({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });

  it("20,000 generated fills, every optional key present or not and every value canonical or not, round-trip", () => {
    // Deterministic generator (mulberry32), so a failure reproduces.
    let seed = 0x5eed;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(values: T[]) => values[Math.floor(random() * values.length)];
    const hexOf = (length: number) => `0x${Array.from({ length }, () => pick([..."0123456789abcdef"])).join("")}`;
    const decimal = () => pick([...CANONICAL_DECIMALS, ...CANONICAL_DECIMALS, ...ODD_DECIMALS, `${Math.floor(random() * 1e6)}.${String(Math.floor(random() * 1e8)).padStart(8, "0")}`]);
    for (let i = 0; i < 20_000; i++) {
      const fill: Record<string, unknown> = { tid: Math.floor(random() * 2 ** 50), time: Math.floor(random() * 2e12) };
      const maybe = (key: string, make: () => unknown) => { if (random() < 0.7) fill[key] = make(); };
      maybe("coin", () => pick(["BTC", "@1", "xyz:ZM", "", 5]));
      for (const key of ["px", "sz", "startPosition", "closedPnl", "fee", "builderFee", "deployerFee", "priorityGas"]) maybe(key, decimal);
      maybe("side", () => pick(["A", "B", "C"]));
      maybe("dir", () => pick(["Open Long", "Sell", null]));
      maybe("hash", () => pick([hexOf(64), `0x${"0".repeat(64)}`, hexOf(63), hexOf(64).toUpperCase()]));
      maybe("oid", () => pick([Math.floor(random() * 1e12), -5, 0.5]));
      maybe("crossed", () => pick([true, false, "true"]));
      maybe("feeToken", () => pick(["USDC", "+0"]));
      maybe("cloid", () => pick([hexOf(32), hexOf(31), null]));
      maybe("builder", () => pick([hexOf(40), hexOf(40).toUpperCase()]));
      maybe("twapId", () => pick([null, Math.floor(random() * 1e6), -1, "x"]));
      maybe("liquidation", () => pick([{ markPx: decimal(), method: pick(["market", "backstop"]) }, { liquidatedUser: hexOf(40), markPx: decimal(), method: "market" },
        { liquidatedUser: hexOf(39), markPx: "1.0", method: "market" }, { method: "market" }, "x"]));
      maybe(`k${Math.floor(random() * 5)}`, () => pick([1, "s", null, { a: [decimal()] }]));
      const decoded = decodeFill(encodeFill(as(fill)));
      if (canonicalJson(decoded) !== canonicalJson(fill)) throw new Error(`Round trip differs for ${JSON.stringify(fill)}: ${JSON.stringify(decoded)}`);
    }
  });
});
