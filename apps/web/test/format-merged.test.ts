import { describe, expect, it } from "vitest";
import * as format from "../src/lib/format";
import * as boardFormat from "../src/lib/board-format";
import * as tradeFormat from "../src/lib/trade-format";
import * as walletBits from "../src/components/wallet/bits";
import { signedUsd1, signedUsd2, signedUsdShort, timeAgo, truncateAddress, usd0, usd1, usd2, usdFull } from "../src/lib/format";

// One helper each (mainnet inventory §B7): truncateAddress replaced
// shortAddress (wallet/bits) and shortHex (trade-format); timeAgo replaced
// ago (trade-format) and agoShort (board-format); the usd* helpers moved
// from trade-format into format.

describe("one address shortener", () => {
  it("reads as the old shortAddress and shortHex did for addresses and hashes", () => {
    const checksum = "0xf80C3A6b1d2E4F5a6B7c8D9e0F1a2B3c4D5e7F1a";
    expect(truncateAddress(checksum)).toBe("0xf80C…7F1a");
    const hash = `0x6fc3${"0".repeat(56)}b891`;
    expect(truncateAddress(hash)).toBe("0x6fc3…b891");
  });

  it("the duplicates are gone", () => {
    expect("shortAddress" in walletBits).toBe(false);
    expect("shortHex" in tradeFormat).toBe(false);
  });
});

describe("one relative time", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  it("formats seconds, minutes, hours and days from a string, number or Date", () => {
    expect(timeAgo("2026-09-30T11:59:30Z", now)).toBe("30s ago");
    expect(timeAgo(now - 52 * 60_000, now)).toBe("52m ago");
    expect(timeAgo(new Date(now - 21 * 3_600_000), now)).toBe("21h ago");
    expect(timeAgo("2026-09-27T11:00:00Z", now)).toBe("3d ago");
  });

  it("is null when the time is missing or invalid, or now is not known yet", () => {
    expect(timeAgo(null, now)).toBeNull();
    expect(timeAgo(undefined, now)).toBeNull();
    expect(timeAgo("not a date", now)).toBeNull();
    expect(timeAgo(now - 60_000, 0)).toBeNull();
  });

  it("never reads as negative for a time slightly ahead of the clock", () => {
    expect(timeAgo(now + 5_000, now)).toBe("0s ago");
  });

  it("the duplicates are gone", () => {
    expect("ago" in tradeFormat).toBe(false);
    expect("agoShort" in boardFormat).toBe(false);
  });
});

describe("the usd helpers live in format", () => {
  it("keep CopyDog's trade-view formats", () => {
    expect([usd2(1_400_000), usd2(-469.97), usd2(null)]).toEqual(["$1.40M", "-$469.97", "$0"]);
    expect([signedUsd2(54_050), signedUsd2(-469.97), signedUsd2(0.001)]).toEqual(["+$54.05K", "-$469.97", "$0.00"]);
    expect([usd1(5_600_000), usd1(29_400), usd1(undefined)]).toEqual(["$5.6M", "$29.4K", "$0.0"]);
    expect([usd0(469.6), usd0(-183_400), usd0(1_234_000_000)]).toEqual(["$470", "-$183K", "$1.2B"]);
    expect([signedUsd1(54_000), signedUsd1(-54_000)]).toEqual(["+$54.0K", "-$54.0K"]);
    expect([signedUsdShort(3_200_000), signedUsdShort(318_500), signedUsdShort(-39)]).toEqual(["+$3.20M", "+$318.5K", "-$39"]);
    expect([usdFull(9_999_999), usdFull(0.001), usdFull(null)]).toEqual(["$9,999,999.00", "$0.00", "$0.00"]);
  });

  it("only in format", () => {
    for (const name of ["usd2", "signedUsd2", "usd1", "usd0", "signedUsd1", "signedUsdShort", "usdFull"]) {
      expect(name in format).toBe(true);
      expect(name in tradeFormat).toBe(false);
    }
  });
});
