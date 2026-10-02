import { expect, it } from "vitest";
import { activityFor, profileFor, UNKNOWN_ADDRESS } from "../src/fixtures/data";
import type { TraderActivityResponse, TraderProfileResponse } from "../src/lib/contracts";
import { traderIsUnknown } from "../src/lib/trader-presence";

const wire = <T,>(value: unknown) => JSON.parse(JSON.stringify(value)) as T;
const profile = (address: string) => wire<TraderProfileResponse>(profileFor(address, false));
const activity = (address: string) => wire<TraderActivityResponse>(activityFor(address, false, 20));

it("waits for both answers before calling an address unknown", () => {
  expect(traderIsUnknown(undefined, undefined)).toBeNull();
  expect(traderIsUnknown(profile(UNKNOWN_ADDRESS), undefined)).toBeNull();
  expect(traderIsUnknown(profile(UNKNOWN_ADDRESS), activity(UNKNOWN_ADDRESS))).toBe(true);
});

it("keeps the page for anything Hyperliquid knows", () => {
  const known = `0x${"ab".repeat(20)}`;
  expect(traderIsUnknown(profile(known), undefined)).toBe(false);
  const blank = profile(UNKNOWN_ADDRESS);
  const quiet = activity(UNKNOWN_ADDRESS);
  // An emptied account that has traded.
  expect(traderIsUnknown(blank, { ...quiet, lastTradeAt: "2026-09-01T00:00:00.000Z" })).toBe(false);
  expect(traderIsUnknown({ ...blank, isVault: true }, quiet)).toBe(false);
  expect(traderIsUnknown({ ...blank, accountValue: 12 }, quiet)).toBe(false);
  // A source was down: the blanks may not be real.
  const partial = { partial: true, sources: { "perp:main": { status: "unavailable" as const, asOf: null, stale: false, maxAgeMs: 60000 } } };
  expect(traderIsUnknown({ ...blank, dataQuality: partial }, quiet)).toBe(false);
});
