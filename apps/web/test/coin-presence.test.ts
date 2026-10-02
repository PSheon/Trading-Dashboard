import { describe, expect, it } from "vitest";

import { coinIsUnknown } from "../src/lib/coin-presence";
import { loadCoinBoard } from "../src/lib/share-card-data";

const pool = { ready: 1136, total: 1136, tradesReady: 247 };
const empty = { items: [], stats: { traders: 0, profit: 0, volume: 0, trades: 0 }, pool };

describe("a coin page for a market nobody trades is the 404", () => {
  it("is unknown only once a filled pool has no trader for it", () => {
    expect(coinIsUnknown(empty)).toBe(true);
    expect(coinIsUnknown({ ...empty, stats: { ...empty.stats, traders: 3 } })).toBe(false);
    expect(coinIsUnknown({ ...empty, items: [{}] as never })).toBe(false);
  });

  it("is not decided without an answer or while the pool is still filling in", () => {
    expect(coinIsUnknown(undefined)).toBeNull();
    expect(coinIsUnknown(null)).toBeNull();
    expect(coinIsUnknown({ ...empty, pool: { ready: 0, total: 1136, tradesReady: 0 } })).toBeNull();
  });

  it("reads the board from the api for the caller, and gives null when the api fails", async () => {
    const seen: Array<{ url: string; forwarded: string | null }> = [];
    const ok = (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), forwarded: new Headers(init.headers).get("x-forwarded-for") });
      return Response.json({ success: true, data: empty });
    }) as unknown as typeof fetch;
    expect(coinIsUnknown(await loadCoinBoard("xyz:NOPE", { apiUrl: "http://api.test/base", fetchImpl: ok, client: "203.0.113.9" }))).toBe(true);
    expect(seen).toEqual([{ url: "http://api.test/base/discover/coins/xyz%3ANOPE", forwarded: "203.0.113.9" }]);

    const down = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
    expect(coinIsUnknown(await loadCoinBoard("BTC", { apiUrl: "http://api.test", fetchImpl: down }))).toBeNull();
    expect(coinIsUnknown(await loadCoinBoard("BTC", { apiUrl: undefined, fetchImpl: ok }))).toBeNull();
  });
});
