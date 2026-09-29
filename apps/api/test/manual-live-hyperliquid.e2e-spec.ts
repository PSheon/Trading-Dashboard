import { actions, equitySnapshots, fills, leaders } from "@trading-dashboard/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import { WatcherService } from "../src/watcher/watcher.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

/**
 * MANUAL, NOT part of `pnpm test` (that only ever runs `**\/*.spec.ts` per
 * vitest.config.ts) — this hits the real, live Hyperliquid mainnet API and
 * a real local Postgres, and takes ~25s by design (two poll cycles with a
 * real gap so a high-volume address has a chance to actually trade in
 * between). Run explicitly with:
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/trading_dashboard_test \
 *     pnpm test:e2e
 *
 * Addresses below were confirmed live (2026-09-29) to currently hold open
 * perp positions / have very high recent trading volume via Hyperliquid's
 * public (unofficial) leaderboard endpoint — see the task report for how
 * they were found. This is NOT re-run on every commit: real trading
 * activity is non-deterministic, so assertions here are deliberately loose
 * (the pipeline must not crash and must produce internally-consistent
 * data), not "a delta must occur within N seconds".
 */
const LIVE_ADDRESSES = [
  "0x5b5d51203a0f9079f8aeb098a6523a13f298c060",
  "0xf5d81a135f756ca16544e53c20fc20643ec3ad53",
  "0xdf9ea6ec3b7109935ccb4fb267e15ac1fb077ab1",
];

describe.skipIf(!process.env.RUN_LIVE_HYPERLIQUID_E2E)("live Hyperliquid + real Postgres (manual)", () => {
  it("runs two real poll cycles and lands sane rows", async () => {
    const db = getTestDb();
    await truncateAll(db);

    await db.insert(leaders).values(
      LIVE_ADDRESSES.map((address) => ({ chain: "hyperliquid" as const, address, active: true, tier: "B" as const })),
    );

    const budgeter = new RequestBudgeterService();
    const info = new HyperliquidInfoClient(budgeter);
    const watcher = new WatcherService(info, db);

    await watcher.runPollCycle();
    console.log("cycle 1 done, cached states:", watcher.getCachedStates().size);

    await new Promise((resolve) => setTimeout(resolve, 25_000));

    await watcher.runPollCycle();
    console.log("cycle 2 done");

    const insertedFills = await db.select().from(fills);
    const insertedActions = await db.select().from(actions);
    console.log(`fills: ${insertedFills.length}, actions: ${insertedActions.length}`);
    for (const a of insertedActions) {
      console.log(" action:", a.address, a.coin, a.kind, a.side, a.notionalUsd, a.avgPx);
    }

    // Sanity, not "activity happened": every cached address has a
    // real accountValue, and if any fills landed, their (address,coin)
    // shows up in the cache with a real position.
    for (const address of LIVE_ADDRESSES) {
      const cached = watcher.getCachedStates().get(address);
      expect(cached).toBeDefined();
      expect(Number(cached!.response.marginSummary.accountValue)).toBeGreaterThanOrEqual(0);
    }

    if (insertedFills.length > 0) {
      expect(insertedActions.length).toBeGreaterThan(0);
      const dupTids = new Set(insertedFills.map((f) => f.tid.toString()));
      expect(dupTids.size).toBe(insertedFills.length); // dedupe held
    }

    await closeTestDb();
  }, 60_000);

  it("writes real position/equity snapshots from the cache (W4 adapted)", async () => {
    const db = getTestDb();
    await truncateAll(db);
    await db.insert(leaders).values({ chain: "hyperliquid", address: LIVE_ADDRESSES[0], active: true, tier: "B" });

    const budgeter = new RequestBudgeterService();
    const info = new HyperliquidInfoClient(budgeter);
    const watcher = new WatcherService(info, db);
    await watcher.runPollCycle();

    const cached = watcher.getCachedStates().get(LIVE_ADDRESSES[0]);
    expect(cached).toBeDefined();

    await db.insert(equitySnapshots).values({
      chain: "hyperliquid",
      address: LIVE_ADDRESSES[0],
      ts: cached!.fetchedAt,
      accountValue: cached!.response.marginSummary.accountValue,
      totalMarginUsed: cached!.response.marginSummary.totalMarginUsed,
      withdrawable: cached!.response.withdrawable,
    });

    const rows = await db.select().from(equitySnapshots).where(eq(equitySnapshots.address, LIVE_ADDRESSES[0]));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].accountValue)).toBeGreaterThan(0);

    await closeTestDb();
  }, 30_000);
});
