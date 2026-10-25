import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { coinIcons, createCoinIconSource } from "../src/lib/coin-icon-source";
import { ICONS_PER_MINUTE, iconRetryAfter, imageRetryAfter, resetImageLimiter } from "../src/lib/client-address";
import { GET as icon } from "../src/app/api/coin-icon/[coin]/route";
import { loadSeenMarketNames } from "../src/lib/share-card-data";

beforeEach(() => resetImageLimiter());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const svg = () => new Response("<svg></svg>", { headers: { "content-type": "image/svg+xml" } });

it("fetches an icon upstream only for a market apps/api's catalog lists (audit C)", async () => {
  const upstream = vi.fn<typeof fetch>(async () => svg());
  const markets = vi.fn(async () => ["BTC", "xyz:TSLA", "kPEPE"]);
  const icons = createCoinIconSource({ fetchImpl: upstream, markets });
  expect(await icons.get("BTC")).toEqual({ svg: "<svg></svg>" });
  // Well-formed but no market: no request to app.hyperliquid.xyz.
  expect(await icons.get("NOTAMARKET1")).toBeNull();
  expect(await icons.get("zz:FAKE")).toBeNull();
  expect(await icons.isKnownMarket("zz:FAKE")).toBe(false);
  expect(await icons.isKnownMarket("BTC")).toBe(true);
  expect(upstream.mock.calls.map(([url]) => String(url))).toEqual(["https://app.hyperliquid.xyz/coins/BTC.svg"]);
  // The list is read once, not per icon.
  expect(markets).toHaveBeenCalledTimes(1);
});

it("returns no content for a known market without a logo so the client can draw its glyph", async () => {
  vi.stubEnv("NEXT_TEST_MODE", "0");
  vi.spyOn(coinIcons, "get").mockResolvedValue(null);
  vi.spyOn(coinIcons, "isKnownMarket").mockResolvedValue(true);
  const res = await icon(new Request("http://web.test/api/coin-icon/xyz%3ANATGAS"), { params: Promise.resolve({ coin: "xyz:NATGAS" }) } as never);
  expect(res.status).toBe(204);
  expect(await res.text()).toBe("");
  expect(res.headers.get("cache-control")).toBe("public, max-age=60");
});

it("preserves 404 for an unknown market", async () => {
  vi.stubEnv("NEXT_TEST_MODE", "0");
  vi.spyOn(coinIcons, "get").mockResolvedValue(null);
  vi.spyOn(coinIcons, "isKnownMarket").mockResolvedValue(false);
  const res = await icon(new Request("http://web.test/api/coin-icon/FAKE"), { params: Promise.resolve({ coin: "FAKE" }) } as never);
  expect(res.status).toBe(404);
});

it("refuses every uncached icon while the market list cannot be read", async () => {
  const upstream = vi.fn<typeof fetch>(async () => svg());
  const icons = createCoinIconSource({ fetchImpl: upstream, markets: async () => null });
  expect(await icons.get("BTC")).toBeNull();
  expect(upstream).not.toHaveBeenCalled();
});

it("while the market list is null, serves the markets apps/api's own answers name and still refuses any other name (Stage 2026-10-25, D19)", async () => {
  let clock = 1_000_000;
  const upstream = vi.fn<typeof fetch>(async () => svg());
  const markets = vi.fn<() => Promise<readonly string[] | null>>(async () => null);
  const seen = vi.fn(async () => ["BTC", "xyz:TSLA"]);
  const icons = createCoinIconSource({ fetchImpl: upstream, markets, seen, now: () => clock });
  expect(await icons.get("BTC")).toEqual({ svg: "<svg></svg>" });
  expect(await icons.isKnownMarket("xyz:TSLA")).toBe(true);
  expect(await icons.get("NOTAMARKET1")).toBeNull();
  expect(upstream.mock.calls.map(([url]) => String(url))).toEqual(["https://app.hyperliquid.xyz/coins/BTC.svg"]);
  expect(markets).toHaveBeenCalledTimes(1);
  // The catalog is asked for again after a minute, and its list then rules.
  markets.mockResolvedValue(["BTC", "ETH"]);
  clock += 60_001;
  expect(await icons.isKnownMarket("ETH")).toBe(true);
  expect(await icons.isKnownMarket("xyz:TSLA")).toBe(false);
  expect(markets).toHaveBeenCalledTimes(2);
});

it("names the markets from the api's 24h volumes and the pool's coin index", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (url) => Response.json({ success: true, data: String(url).endsWith("/discover/markets")
    ? { markets: null, volumes: { BTC: 1, "xyz:TSLA": 2 } } : { items: [{ coin: "HYPE" }, { coin: "BTC" }] } }));
  expect((await loadSeenMarketNames({ apiUrl: "http://api.test", fetchImpl }))?.sort()).toEqual(["BTC", "HYPE", "xyz:TSLA"]);
  expect(await loadSeenMarketNames({ apiUrl: "http://api.test", fetchImpl: async () => new Response("down", { status: 503 }) })).toBeNull();
});

it("asks for an unreadable market list again after a minute, not on every icon request", async () => {
  let clock = 1_000_000;
  const upstream = vi.fn<typeof fetch>(async () => svg());
  const markets = vi.fn<() => Promise<readonly string[] | null>>(async () => null);
  const icons = createCoinIconSource({ fetchImpl: upstream, markets, now: () => clock });
  for (const coin of ["BTC", "ETH", "SOL", "BTC"]) expect(await icons.get(coin)).toBeNull();
  expect(markets).toHaveBeenCalledTimes(1);
  // A failed read (an exception) waits as well.
  markets.mockRejectedValueOnce(new Error("api unreachable"));
  clock += 60_001;
  expect(await icons.get("BTC")).toBeNull();
  expect(await icons.get("ETH")).toBeNull();
  expect(markets).toHaveBeenCalledTimes(2);
  // Once the list reads, icons are served.
  markets.mockResolvedValue(["BTC"]);
  clock += 60_001;
  expect(await icons.get("BTC")).toEqual({ svg: "<svg></svg>" });
  expect(markets).toHaveBeenCalledTimes(3);
  expect(upstream).toHaveBeenCalledTimes(1);
});

it("limits icons per client, apart from the share images' count", async () => {
  const now = 5_000_000;
  for (let i = 0; i < ICONS_PER_MINUTE; i++) expect(iconRetryAfter("203.0.113.7", now)).toBe(0);
  expect(iconRetryAfter("203.0.113.7", now)).toBe(60);
  expect(iconRetryAfter("203.0.113.8", now)).toBe(0);
  expect(imageRetryAfter("203.0.113.7", now)).toBe(0);
});

it("the icon route answers 429 with Retry-After past the limit, before any lookup", async () => {
  vi.stubEnv("NEXT_TEST_MODE", "1");
  for (let i = 0; i < ICONS_PER_MINUTE; i++) iconRetryAfter("203.0.113.9");
  const res = await icon(new Request("http://web.test/api/coin-icon/BTC", { headers: { "x-forwarded-for": "203.0.113.9" } }), { params: Promise.resolve({ coin: "BTC" }) } as never);
  expect(res.status).toBe(429);
  expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  const other = await icon(new Request("http://web.test/api/coin-icon/BTC", { headers: { "x-forwarded-for": "203.0.113.10" } }), { params: Promise.resolve({ coin: "BTC" }) } as never);
  expect(other.status).toBe(404);
});
