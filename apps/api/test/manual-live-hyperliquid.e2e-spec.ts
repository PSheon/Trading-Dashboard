import { EventEmitter2 } from "@nestjs/event-emitter";
import { actions, fills, leaders } from "@trading-dashboard/shared";
import { describe, expect, it } from "vitest";

import { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import { RequestBudgeterService } from "../src/hyperliquid/request-budgeter.service.js";
import { AccountStateService } from "../src/watcher/account-state.service.js";
import { ACTION_CREATED_EVENT } from "../src/watcher/action-created.event.js";
import { FillSyncService } from "../src/watcher/fill-sync.service.js";
import { TradeFeedService } from "../src/watcher/trade-feed.service.js";
import { WatcherService } from "../src/watcher/watcher.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

/**
 * MANUAL, against live Hyperliquid mainnet and a local Postgres; not part of
 * `pnpm test`. Run with:
 *
 *   RUN_LIVE_HYPERLIQUID_E2E=1 \
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5433/trading_dashboard_test \
 *     pnpm --filter @trading-dashboard/api test:e2e
 *
 * Picks the most active addresses from recent BTC/ETH/SOL/HYPE trades as
 * leaders, runs the real trade feed for 90 s, and checks that every stored
 * fill is unique per (address, tid), that actions reference stored fills,
 * and how long it took from trade time to action. Live activity varies, so
 * it asserts consistency, not volume.
 */
const RUN_MS = 90_000;

describe.skipIf(!process.env.RUN_LIVE_HYPERLIQUID_E2E)("live Hyperliquid + real Postgres (manual)", () => {
  it("detects live trades of watched addresses through the trades feed", { timeout: RUN_MS + 60_000 }, async () => {
    const db = getTestDb();
    await truncateAll(db);

    const info = new HyperliquidInfoClient(new RequestBudgeterService());
    const counts = new Map<string, number>();
    for (const coin of ["BTC", "ETH", "SOL", "HYPE"]) {
      const res = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "recentTrades", coin }),
      });
      for (const t of (await res.json()) as Array<{ users: string[] }>) {
        for (const u of t.users) counts.set(u, (counts.get(u) ?? 0) + 1);
      }
    }
    const watched = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([a]) => a);
    await db.insert(leaders).values(watched.map((address) => ({ chain: "hyperliquid", address, active: true, tier: "B" as const })));

    const events = new EventEmitter2();
    const latencies: number[] = [];
    events.on(ACTION_CREATED_EVENT, (row: { ts: Date }) => latencies.push(Date.now() - row.ts.getTime()));
    const accounts = new AccountStateService(info, db);
    const fillSync = new FillSyncService(info, db, accounts, events);
    const feed = new TradeFeedService(info);
    const watcher = new WatcherService(feed, fillSync, accounts, db);

    await watcher.refreshWatched();
    await feed.start({ onTrade: (a, t) => watcher.onTrade(a, t), onGap: () => {} });
    await new Promise((r) => setTimeout(r, RUN_MS));
    const status = feed.status();
    feed.stop();
    await new Promise((r) => setTimeout(r, 25_000)); // let in-flight syncs and retries finish

    const storedFills = await db.select().from(fills);
    const storedActions = await db.select().from(actions);
    const keys = new Set(storedFills.map((f) => `${f.address}:${f.tid}`));
    const sorted = [...latencies].sort((a, b) => a - b);
    console.log({
      watched: watched.length,
      markets: status.markets,
      sockets: `${status.socketsOpen}/${status.socketsTotal}`,
      fills: storedFills.length,
      actions: storedActions.length,
      alertsEmitted: latencies.length,
      latencyMsP50: sorted[Math.floor(sorted.length / 2)],
      latencyMsMax: sorted[sorted.length - 1],
    });

    expect(status.markets).toBeGreaterThan(100);
    expect(status.socketsOpen).toBe(status.socketsTotal);
    expect(keys.size).toBe(storedFills.length);
    for (const action of storedActions) {
      for (const tid of action.fillIds) expect(keys.has(`${action.address}:${tid}`)).toBe(true);
    }
    await closeTestDb();
  });
});
