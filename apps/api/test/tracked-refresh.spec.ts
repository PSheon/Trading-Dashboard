import { leaders } from "@trading-dashboard/shared/database";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { TradeAnalyticsRepository, type AnalyticsRow } from "../src/traders/trade-analytics.repository.js";
import { ESSENTIAL_RANK, PAGE_RANK, UNRANKED_BASE } from "../src/hyperliquid/request-budgeter.service.js";
import { TRACKED_BACKOFF_BASE_MS, TRACKED_BACKOFF_MAX_MS, TRACKED_REFRESH_PER_TICK, TradeAnalyticsService } from "../src/traders/trade-analytics.service.js";
import type { TradersService } from "../src/traders/traders.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const MINUTE = 60_000;
const address = (n: number) => `0x${String(n).padStart(2, "0").repeat(20)}`;

describe("the worker's turn over watched addresses (refreshTracked)", () => {
  const db = getTestDb();
  let service: TradeAnalyticsService;
  let compute: ReturnType<typeof vi.spyOn>;
  const failing = new Set<string>();

  beforeEach(async () => {
    await truncateAll(db);
    failing.clear();
    service = new TradeAnalyticsService(new TradeAnalyticsRepository(db), { isTracked: async () => true } as unknown as TradersService, {} as HyperliquidInfoClient);
    // The computation itself is covered elsewhere: here it fails or not per address, and writes nothing.
    compute = vi.spyOn(service, "compute").mockImplementation(async (target: string) => {
      if (failing.has(target)) throw new Error("history too large");
      return {} as AnalyticsRow;
    });
  });
  afterAll(async () => { await closeTestDb(); });

  it("addresses whose refresh keeps failing back off and no longer take every slot of a turn (audit: trackedDue)", async () => {
    // Six watched addresses that fail (the oldest: they have no figures and sort first) and one that does not.
    for (let n = 1; n <= TRACKED_REFRESH_PER_TICK + 1; n++) await db.insert(leaders).values({ address: address(n) });
    for (let n = 1; n <= TRACKED_REFRESH_PER_TICK; n++) failing.add(address(n));
    const t0 = Date.now();
    expect(await service.refreshTracked(t0)).toEqual([]);
    expect(compute).toHaveBeenCalledTimes(TRACKED_REFRESH_PER_TICK);
    // The next turn, a minute later, gets to the seventh.
    expect(await service.refreshTracked(t0 + MINUTE)).toEqual([address(7)]);
    // After their backoff they are tried again, and back off for twice as long.
    compute.mockClear();
    await service.refreshTracked(t0 + TRACKED_BACKOFF_BASE_MS + 1);
    expect(compute.mock.calls.map((call: unknown[]) => call[0])).toEqual(expect.arrayContaining([...failing]));
    expect(service.trackedRetryAt(address(1))).toBe(t0 + TRACKED_BACKOFF_BASE_MS + 1 + 2 * TRACKED_BACKOFF_BASE_MS);
  });

  it("the backoff is capped, and a success clears it", async () => {
    await db.insert(leaders).values({ address: address(1) });
    failing.add(address(1));
    let now = Date.now();
    for (let i = 0; i < 10; i++) {
      await service.refreshTracked(now);
      now = service.trackedRetryAt(address(1))!;
    }
    const last = service.trackedRetryAt(address(1))!;
    await service.refreshTracked(last);
    expect(service.trackedRetryAt(address(1))! - last).toBe(TRACKED_BACKOFF_MAX_MS);
    failing.clear();
    expect(await service.refreshTracked(service.trackedRetryAt(address(1))!)).toEqual([address(1)]);
    expect(service.trackedRetryAt(address(1))).toBeUndefined();
  });

  it("refreshes at the tracked rank: behind every page, ahead of the pool, history and backfill (gap audit 2026-10-05)", async () => {
    await db.insert(leaders).values({ address: address(1) });
    expect(await service.refreshTracked()).toEqual([address(1)]);
    const rank = (compute.mock.calls[0] as [string, boolean, { rank?: number }])[2].rank!;
    expect(rank).toBe(ESSENTIAL_RANK.tracked);
    expect(rank).toBeGreaterThan(PAGE_RANK.analytics);
    expect(rank).toBeLessThan(UNRANKED_BASE - 1);
  });

  it("a failed funding read backs the address off like a failed rebuild (it was swallowed, gap audit 2026-10-05)", async () => {
    await db.insert(leaders).values({ address: address(1) });
    const funding = vi.spyOn(service, "fundingStep").mockRejectedValue(new Error("userFunding 500"));
    const t0 = Date.now();
    expect(await service.refreshTracked(t0)).toEqual([]);
    expect(funding).toHaveBeenCalledTimes(1);
    expect(service.trackedRetryAt(address(1))).toBe(t0 + TRACKED_BACKOFF_BASE_MS);
    // While backing off it is not tried again.
    expect(await service.refreshTracked(t0 + 1)).toEqual([]);
    expect(funding).toHaveBeenCalledTimes(1);
    funding.mockResolvedValue(undefined);
    expect(await service.refreshTracked(t0 + TRACKED_BACKOFF_BASE_MS + 1)).toEqual([address(1)]);
    expect(service.trackedRetryAt(address(1))).toBeUndefined();
  });
});
