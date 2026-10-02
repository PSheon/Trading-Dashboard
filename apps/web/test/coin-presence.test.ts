import { wireCoinBoardSchema } from "@trading-dashboard/shared/contracts";
import { describe, expect, it } from "vitest";

import { coinIsUnknown } from "../src/lib/coin-presence";
import { loadCoinBoard } from "../src/lib/share-card-data";

const pool = { ready: 1136, total: 1136, tradesReady: 247 };
const empty = { items: [], stats: { traders: 0, profit: 0, volume: 0, trades: 0 }, pool };

describe("a coin page is the 404 only for a name that is not a Hyperliquid market", () => {
  it("a real market nobody in the pool has traded is the page (CopyDog's 尚無市場資料), not the 404", () => {
    expect(coinIsUnknown({ ...empty, listed: true })).toBe(false);
    const filling = { ...empty, listed: true, pool: { ready: 0, total: 1136, tradesReady: 0 } };
    expect(coinIsUnknown(filling)).toBe(false);
  });

  it("a name outside Hyperliquid's universe is unknown, unless the pool has rows for it", () => {
    expect(coinIsUnknown({ ...empty, listed: false })).toBe(true);
    expect(coinIsUnknown({ ...empty, listed: false, stats: { ...empty.stats, traders: 3 } })).toBe(false);
    expect(coinIsUnknown({ ...empty, listed: false, items: [{}] as never })).toBe(false);
  });

  it("is not decided without an answer, or when the api does not know the universe (null, or an older api without the field)", () => {
    expect(coinIsUnknown(undefined)).toBeNull();
    expect(coinIsUnknown(null)).toBeNull();
    expect(coinIsUnknown({ ...empty, listed: null })).toBeNull();
    expect(coinIsUnknown(empty)).toBeNull();
    // What the browser makes of an older api's answer.
    const old = wireCoinBoardSchema.parse({ coin: "MEGA", market: "crypto", ...empty, updatedAt: null });
    expect(old.listed).toBeNull();
    expect(coinIsUnknown(old)).toBeNull();
  });

  it("reads the board from the api for the caller, and gives null when the api fails", async () => {
    const seen: Array<{ url: string; forwarded: string | null }> = [];
    const ok = (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), forwarded: new Headers(init.headers).get("x-forwarded-for") });
      return Response.json({ success: true, data: { ...empty, listed: false } });
    }) as unknown as typeof fetch;
    expect(coinIsUnknown(await loadCoinBoard("xyz:NOPE", { apiUrl: "http://api.test/base", fetchImpl: ok, client: "203.0.113.9" }))).toBe(true);
    expect(seen).toEqual([{ url: "http://api.test/base/discover/coins/xyz%3ANOPE", forwarded: "203.0.113.9" }]);

    const down = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
    expect(coinIsUnknown(await loadCoinBoard("BTC", { apiUrl: "http://api.test", fetchImpl: down }))).toBeNull();
    expect(coinIsUnknown(await loadCoinBoard("BTC", { apiUrl: undefined, fetchImpl: ok }))).toBeNull();
  });
});
