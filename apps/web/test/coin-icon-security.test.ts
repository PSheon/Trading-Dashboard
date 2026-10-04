import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCoinIconSource } from "../src/lib/coin-icon-source";
import { ICONS_PER_MINUTE, iconRetryAfter, imageRetryAfter, resetImageLimiter } from "../src/lib/client-address";
import { GET as icon } from "../src/app/api/coin-icon/[coin]/route";

beforeEach(() => resetImageLimiter());
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const svg = () => new Response("<svg></svg>", { headers: { "content-type": "image/svg+xml" } });

it("fetches an icon upstream only for a market apps/api's catalog lists (audit C)", async () => {
  const upstream = vi.fn<typeof fetch>(async () => svg());
  const markets = vi.fn(async () => ["BTC", "xyz:TSLA", "kPEPE"]);
  const icons = createCoinIconSource({ fetchImpl: upstream, markets });
  expect(await icons.get("BTC")).toEqual({ svg: "<svg></svg>" });
  // Well-formed but no market: no request to app.hyperliquid.xyz.
  expect(await icons.get("NOTAMARKET1")).toBeNull();
  expect(await icons.get("zz:FAKE")).toBeNull();
  expect(upstream.mock.calls.map(([url]) => String(url))).toEqual(["https://app.hyperliquid.xyz/coins/BTC.svg"]);
  // The list is read once, not per icon.
  expect(markets).toHaveBeenCalledTimes(1);
});

it("refuses every uncached icon while the market list cannot be read", async () => {
  const upstream = vi.fn<typeof fetch>(async () => svg());
  const icons = createCoinIconSource({ fetchImpl: upstream, markets: async () => null });
  expect(await icons.get("BTC")).toBeNull();
  expect(upstream).not.toHaveBeenCalled();
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
