import { afterEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "../src/traders/ttl-cache.js";
import { HEAVY_CACHE_MAX_ENTRIES, SPARKLINE_CACHE_MAX_ENTRIES, TradersService } from "../src/traders/traders.service.js";
import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";

/** Expired entries must not stay resident until 5 000 other keys push them
 * out: the api and worker kept GBs of fill lists for traders nobody had
 * looked at in hours. */
describe("TtlCache sweeping", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases expired entries on a timer, without any read or write", () => {
    vi.useFakeTimers();
    const cache = new TtlCache<number[]>(60_000, 5_000, undefined, { sweepTimer: true });
    for (let i = 0; i < 50; i++) cache.set(`k${i}`, Array.from({ length: 1_000 }, () => i));
    expect(cache.size).toBe(50);
    vi.advanceTimersByTime(59_999);
    expect(cache.size).toBe(50);
    vi.advanceTimersByTime(60_001);
    expect(cache.size).toBe(0);
    // Empty, the sweeper stops: nothing is left pending.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sweeps expired entries when a new key is written, once per interval", () => {
    let now = 0;
    const cache = new TtlCache<number>(10_000, 5_000, () => now);
    for (let i = 0; i < 100; i++) cache.set(`old${i}`, i);
    now = 10_000;
    cache.set("new", 1);
    expect(cache.size).toBe(1);
    expect(cache.peek("new")).toEqual({ value: 1 });
    cache.clear();
  });

  it("keeps fresh entries and respects the size bound; without sweepTimer it schedules nothing", () => {
    vi.useFakeTimers();
    const cache = new TtlCache<number>(60_000, 3);
    for (let i = 0; i < 5; i++) cache.set(`k${i}`, i);
    expect(cache.size).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(30_000);
    expect(cache.size).toBe(3);
    expect(cache.peek("k4")).toEqual({ value: 4 });
    cache.clear();
  });

  it("the trader caches holding whole fill lists and portfolios are small", () => {
    const service = new TradersService(
      {} as never,
      {} as HyperliquidInfoClient,
      {} as never,
      {} as never,
      {} as never,
    );
    expect(HEAVY_CACHE_MAX_ENTRIES).toBeLessThanOrEqual(200);
    for (const cache of [service.userFillsCache, service.twapFillsCache, service.portfolioCache]) {
      expect(cache.maxEntries).toBe(HEAVY_CACHE_MAX_ENTRIES);
      for (let i = 0; i <= HEAVY_CACHE_MAX_ENTRIES; i++) cache.set(`0x${i}`, [] as never);
      expect(cache.size).toBe(HEAVY_CACHE_MAX_ENTRIES);
      cache.clear();
    }
    expect(service.sparklineCache.maxEntries).toBe(SPARKLINE_CACHE_MAX_ENTRIES);
    // The heavy caches release expired entries on their own.
    vi.useFakeTimers();
    for (const cache of [service.userFillsCache, service.twapFillsCache, service.portfolioCache, service.sparklineCache]) {
      cache.set("0xidle", [] as never);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(11 * 60_000);
      expect(cache.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
