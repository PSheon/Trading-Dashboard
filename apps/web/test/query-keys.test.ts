import { describe, expect, it } from "vitest";

import { queryKeys } from "../src/lib/query-keys";

const MIXED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const LOWER = MIXED.toLowerCase();

describe("trader query keys", () => {
  it("cache one trader under one key whatever the address casing", () => {
    const t = queryKeys.trader;
    const keys = (a: string) => [
      t.profile(a), t.activity(a), t.portfolio(a, "30d", "all"), t.analytics(a, "30d"), t.trades(a, "open"),
      t.orders(a), t.twap(a), t.transfers(a), t.fills(a, 50), t.copyScore(a), t.copyActivity(a),
    ];
    expect(keys(MIXED)).toEqual(keys(LOWER));
    for (const key of keys(MIXED)) expect(key, key[0]).toContain(LOWER);
  });

  it("keeps profiles as the prefix of every profile key", () => {
    expect(queryKeys.trader.profile(MIXED).slice(0, queryKeys.trader.profiles.length)).toEqual([...queryKeys.trader.profiles]);
  });
});
