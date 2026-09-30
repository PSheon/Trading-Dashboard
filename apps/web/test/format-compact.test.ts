import { describe, expect, it } from "vitest";
import { createFormatter, numCompact, usdCompact } from "../src/lib/format";

describe("CopyDog compact dollars", () => {
  it("uses one decimal on K / M / B and whole dollars below $1,000", () => {
    expect(usdCompact(930_200)).toBe("$930.2K");
    expect(usdCompact(23_412_000, { sign: true })).toBe("+$23.4M");
    expect(usdCompact(1_234_000_000)).toBe("$1.2B");
    expect(usdCompact(-403.4)).toBe("-$403");
    expect(usdCompact(0.2, { sign: true })).toBe("$0");
    expect(usdCompact(null)).toBe("—");
  });

  it("never falls back to 萬 / 億 in zh-TW", () => {
    const zh = createFormatter("zh-TW");
    expect(zh.usd(17_400_000, { compact: true })).toBe("$17.4M");
    expect(zh.usd(-183_000, { compact: true, sign: true })).toBe("-$183.0K");
    expect(zh.compactNum(12_345)).toBe("12.3K");
    expect(numCompact(-2_500_000)).toBe("-2.5M");
    // Below $1,000 the compact form keeps cents, as before.
    expect(zh.usd(12.5, { compact: true })).toBe("$12.50");
  });
});
