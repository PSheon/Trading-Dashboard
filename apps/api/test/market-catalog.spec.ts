import { describe, expect, it, vi } from "vitest";

import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { HyperliquidRestCapacityError } from "../src/hyperliquid/hyperliquid-capacity-error.js";
import { MarketCatalogService } from '../src/hyperliquid/market-catalog.service.js';
import { withRequestSignal } from "../src/runtime/request-context.js";
import { MARKET_CATALOG_TTL_MS } from '../src/config/constants/cache-ttls.js';
import { MARKET_CATALOG_RETRY_MS } from '../src/config/constants/hyperliquid.js';

const universe = (names: string[], delisted: string[] = []) => ({ universe: names.map((name) => ({ name, szDecimals: 2, maxLeverage: 10, ...(delisted.includes(name) ? { isDelisted: true } : {}) })) });
const withContexts = (u: ReturnType<typeof universe>) => [u, u.universe.map(() => ({ dayNtlVlm: "1000" }))] as const;
/** What Stage's copy meter answered (2026-10-25): no room within the wait. */
const exhausted = () => new HyperliquidRestCapacityError(30_000);

function setup() {
  const dexUniverse = (dex?: string) => (dex === "xyz" ? universe(["xyz:TSLA", "xyz:OLD"], ["xyz:OLD"]) : dex === "empty" ? universe([]) : universe(["BTC", "ETH", "MEGA"]));
  const info = {
    perpDexs: vi.fn(async () => [null, { name: "xyz", assetToStreamingOiCap: [["xyz:TSLA", "1"], ["xyz:NEW", "1"]] }, { name: "empty" }]),
    metaAndAssetCtxs: vi.fn(async (_lane: string, _rank: unknown, dex?: string): Promise<unknown> => withContexts(dexUniverse(dex))),
    // A sweep of `meta` reads of its own never got through on Stage.
    meta: vi.fn(async () => { throw exhausted(); }),
  };
  const catalog = new MarketCatalogService(info as unknown as HyperliquidInfoClient);
  let now = 1_000_000;
  catalog.now = () => now;
  return { info, catalog, advance: (ms: number) => { now += ms; } };
}

describe("MarketCatalogService", () => {
  it("lists the main dex and every HIP-3 dex, delisted markets included, and nothing else", async () => {
    const { catalog, info } = setup();
    expect(await catalog.isListed("MEGA")).toBe(true);
    expect(await catalog.isListed("xyz:TSLA")).toBe(true);
    expect(await catalog.isListed("xyz:OLD")).toBe(true); // delisted, still a real market
    expect(await catalog.isListed("xyz:NEW")).toBe(true); // listed on the dex, not yet in its meta
    expect(await catalog.isListed("NOPE123")).toBe(false);
    expect(await catalog.isListed("xyz:NOPE")).toBe(false);
    expect(await catalog.isListed("TSLA")).toBe(false); // a HIP-3 name without its dex is no market
    expect(await catalog.isListed("btc")).toBe(false);
    expect(info.perpDexs).toHaveBeenCalledTimes(1);
    expect(info.metaAndAssetCtxs.mock.calls.map((c) => c[2])).toEqual([undefined, "xyz", "empty"]);
  });

  it("recovers from a quota-exhausted first read through the volume read the pages already make (Stage 2026-10-25, D19)", async () => {
    const { catalog, info, advance } = setup();
    // At start the copy meter's background lane has no room within the wait.
    info.perpDexs.mockRejectedValueOnce(exhausted());
    catalog.onModuleInit();
    await vi.waitFor(() => expect(info.perpDexs).toHaveBeenCalledTimes(1));
    await new Promise((r) => setImmediate(r));
    expect(await catalog.markets()).toBeNull();
    // A minute later a home load asks for the trending markets: that one
    // read gives the volumes and the market list alike.
    advance(MARKET_CATALOG_RETRY_MS);
    expect(await catalog.trending()).toEqual(["BTC", "ETH", "MEGA", "xyz:TSLA"]);
    expect(await catalog.isListed("xyz:OLD")).toBe(true);
    expect([...(await catalog.markets())!].sort()).toEqual(["BTC", "ETH", "MEGA", "xyz:NEW", "xyz:OLD", "xyz:TSLA"]);
    expect(info.meta).not.toHaveBeenCalled();
  });

  it("a market-list request alone retries the read once the gap has passed, and one read serves list and volumes", async () => {
    const { catalog, info, advance } = setup();
    info.perpDexs.mockRejectedValueOnce(exhausted());
    expect(await catalog.markets()).toBeNull();
    advance(MARKET_CATALOG_RETRY_MS);
    expect((await catalog.markets())?.has("BTC")).toBe(true);
    expect([...(await catalog.dayVolumes())!.keys()]).toContain("xyz:TSLA");
    expect(info.perpDexs).toHaveBeenCalledTimes(2);
  });

  it("reads once an hour, and keeps the last good list when a re-read fails", async () => {
    const { catalog, info, advance } = setup();
    await catalog.markets();
    advance(MARKET_CATALOG_TTL_MS - 1);
    await catalog.isListed("BTC");
    expect(info.perpDexs).toHaveBeenCalledTimes(1);
    advance(2);
    info.perpDexs.mockRejectedValueOnce(new Error("Hyperliquid info request failed: 429"));
    expect(await catalog.isListed("BTC")).toBe(true);
    await vi.waitFor(() => expect(info.perpDexs).toHaveBeenCalledTimes(2));
    // Failed: the stale list answers and the next read waits for the retry gap.
    await new Promise((r) => setImmediate(r));
    expect(await catalog.isListed("NOPE123")).toBe(false);
    expect(info.perpDexs).toHaveBeenCalledTimes(2);
    advance(MARKET_CATALOG_RETRY_MS);
    await catalog.isListed("BTC");
    await vi.waitFor(() => expect(info.perpDexs).toHaveBeenCalledTimes(3));
  });

  it("answers null, never false, while no list has been read", async () => {
    const { catalog, info } = setup();
    info.perpDexs.mockRejectedValueOnce(new Error("down"));
    expect(await catalog.isListed("NOPE123")).toBeNull();
    // Within the retry gap nothing is asked again and the answer stays unknown.
    expect(await catalog.isListed("BTC")).toBeNull();
    expect(await catalog.trending()).toEqual([]);
    expect(info.perpDexs).toHaveBeenCalledTimes(1);

    const slow = setup();
    let release!: () => void;
    slow.info.perpDexs.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([null]); }));
    expect(await slow.catalog.isListed("BTC", 10)).toBeNull();
    release();
    await vi.waitFor(async () => expect(await slow.catalog.isListed("BTC", 10)).toBe(true));
  });

  it("an empty answer from Hyperliquid is a failure, not an empty universe", async () => {
    const { catalog, info } = setup();
    info.perpDexs.mockResolvedValueOnce([null]);
    info.metaAndAssetCtxs.mockResolvedValueOnce(withContexts(universe([])));
    expect(await catalog.isListed("BTC")).toBeNull();
  });

  it("the read is not tied to the request that started it", async () => {
    const { catalog, info } = setup();
    const request = new AbortController();
    let seen: AbortSignal | undefined;
    const { currentRequestSignal } = await import("../src/runtime/request-context.js");
    info.perpDexs.mockImplementationOnce(async () => { seen = currentRequestSignal(); return [null]; });
    await withRequestSignal(request.signal, () => catalog.isListed("BTC"));
    expect(seen).toBeUndefined();
  });
});

describe("trending markets", () => {
  it("ranks actual 24h volume across dexes and caches the result", async () => {
    const info = {
      perpDexs: vi.fn(async () => [null, { name: "xyz" }]),
      metaAndAssetCtxs: vi.fn(async (_lane: string, _rank: unknown, dex?: string) => [
        universe(dex ? ["xyz:TSLA", "xyz:OLD"] : ["BTC", "ETH"], ["xyz:OLD"]),
        dex ? [{ dayNtlVlm: "500" }, { dayNtlVlm: "9000" }] : [{ dayNtlVlm: "100" }, { dayNtlVlm: "200" }],
      ]),
    };
    const catalog = new MarketCatalogService(info as unknown as HyperliquidInfoClient);
    let now = 1_000_000;
    catalog.now = () => now;
    expect(await catalog.trending()).toEqual(["xyz:TSLA", "ETH", "BTC"]);
    expect(await catalog.trending()).toEqual(["xyz:TSLA", "ETH", "BTC"]);
    expect(info.metaAndAssetCtxs).toHaveBeenCalledTimes(2);
    now += 16 * 60_000;
    info.metaAndAssetCtxs.mockRejectedValue(new Error("unavailable"));
    expect(await catalog.trending()).toEqual([]);
    expect(await catalog.trending()).toEqual([]); // retry backoff, expired data never masquerades as fresh
    expect(info.metaAndAssetCtxs).toHaveBeenCalledTimes(3);
  });

  it("bounds a cold read and does not publish a partial dex ranking or market list", async () => {
    const info = {
      perpDexs: vi.fn(async () => [null, { name: "xyz" }]),
      metaAndAssetCtxs: vi.fn(async (_lane: string, _rank: unknown, dex?: string) => {
        if (dex) throw new Error("missing dex");
        return [universe(["BTC"]), [{ dayNtlVlm: "100" }]];
      }),
    };
    const catalog = new MarketCatalogService(info as unknown as HyperliquidInfoClient);
    expect(await catalog.trending()).toEqual([]);
    expect(await catalog.markets()).toBeNull();
    const blocked = new MarketCatalogService({ perpDexs: () => new Promise(() => {}) } as unknown as HyperliquidInfoClient);
    expect(await blocked.trending(1)).toEqual([]);
  });

  it("keeps each active market's 24h volume from the trending read for the admin's market pickers", async () => {
    const { catalog, info } = setup();
    info.metaAndAssetCtxs.mockImplementation(async (_lane: string, _rank: unknown, dex?: string) => (dex === "xyz"
      ? [universe(["xyz:TSLA", "xyz:OLD"], ["xyz:OLD"]), [{ dayNtlVlm: "5000000" }, { dayNtlVlm: "9" }]]
      : dex === "empty" ? [universe([]), []] : [universe(["BTC", "ETH", "MEGA"]), [{ dayNtlVlm: "1200000000" }, { dayNtlVlm: "800000000" }, { dayNtlVlm: "0" }]]));
    expect(await catalog.trending()).toEqual(["BTC", "ETH", "xyz:TSLA"]);
    expect(Object.fromEntries((await catalog.dayVolumes())!)).toEqual({ BTC: 1_200_000_000, ETH: 800_000_000, "xyz:TSLA": 5_000_000 });
  });
});
