import { EventEmitter2 } from "@nestjs/event-emitter";
import { actions, fills } from "@trading-dashboard/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { HlClearinghouseStateResponse, HlUserFill } from "../src/hyperliquid/types.js";
import { AccountStateService } from "../src/watcher/account-state.service.js";
import { ACTION_CREATED_EVENT } from "../src/watcher/action-created.event.js";
import { FillSyncService, PAGE_SIZE } from "../src/watcher/fill-sync.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const A = "0xaaaa";
const B = "0xbbbb";

let nextTid = 1;
function fill(overrides: Partial<HlUserFill> = {}): HlUserFill {
  return {
    coin: "BTC",
    px: "100",
    sz: "1",
    side: "B",
    time: Date.now(),
    startPosition: "0",
    dir: "Open Long",
    closedPnl: "0",
    hash: "0x",
    oid: 1,
    crossed: true,
    fee: "0",
    tid: nextTid++,
    ...overrides,
  };
}

function state(coin: string, szi: string, accountValue = "1000", leverage = 5): HlClearinghouseStateResponse {
  return {
    assetPositions:
      szi === "0"
        ? []
        : [{ type: "oneWay", position: { coin, szi, leverage: { type: "cross", value: leverage }, marginUsed: "1", unrealizedPnl: "0" } }],
    marginSummary: { accountValue, totalMarginUsed: "1", totalNtlPos: "1", totalRawUsd: "1" },
    crossMarginSummary: { accountValue, totalMarginUsed: "1", totalNtlPos: "1", totalRawUsd: "1" },
    withdrawable: "0",
    time: Date.now(),
  };
}

describe("FillSyncService — real Postgres, fake Hyperliquid", () => {
  const db = getTestDb();
  let byAddress: Map<string, HlUserFill[]>;
  let info: {
    userFillsByTime: ReturnType<typeof vi.fn>;
    clearinghouseState: ReturnType<typeof vi.fn>;
  };
  let events: EventEmitter2;
  let emitted: unknown[];
  let sync: FillSyncService;

  beforeEach(async () => {
    await truncateAll(db);
    byAddress = new Map();
    info = {
      userFillsByTime: vi.fn(async (address: string, start: number) =>
        (byAddress.get(address) ?? []).filter((f) => f.time >= start).slice(0, PAGE_SIZE),
      ),
      clearinghouseState: vi.fn(async (_address: string, dex?: string) =>
        dex ? state("xyz:TSLA", "-10", "500", 3) : state("BTC", "1", "1000", 5),
      ),
    };
    events = new EventEmitter2();
    emitted = [];
    events.on(ACTION_CREATED_EVENT, (row) => emitted.push(row));
    const client = info as unknown as HyperliquidInfoClient;
    sync = new FillSyncService(client, db, new AccountStateService(client, db), events);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("stores fills, creates one action, refreshes equity, and emits once; a re-sync of the same window adds nothing", async () => {
    const t = Date.now() - 1000;
    byAddress.set(A, [fill({ time: t, sz: "0.6" }), fill({ time: t, startPosition: "0.6", sz: "0.4" })]);

    const first = await sync.sync(A, "live", t - 10_000);
    expect(first).toMatchObject({ fetched: 2, inserted: 2, actions: 1, missingTids: [] });
    expect(info.clearinghouseState).toHaveBeenCalledWith(A, undefined, "live");
    expect(info.userFillsByTime).toHaveBeenCalledWith(A, t - 10_000, undefined, "live");

    const [action] = await db.select().from(actions);
    expect(action).toMatchObject({ kind: "open", side: "long", leverage: "5" });
    expect(emitted).toHaveLength(1);

    const second = await sync.sync(A, "sweep", t - 60_000);
    expect(second).toMatchObject({ fetched: 2, inserted: 0, actions: 0 });
    expect(await db.select().from(actions)).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  it("keeps both counterparties' fills of one trade (shared tid)", async () => {
    const t = Date.now();
    const shared = 424242;
    byAddress.set(A, [fill({ tid: shared, time: t, side: "B" })]);
    byAddress.set(B, [fill({ tid: shared, time: t, side: "A", dir: "Open Short" })]);

    await sync.sync(A, "live", t - 1000);
    await sync.sync(B, "live", t - 1000);

    const rows = await db.select().from(fills).where(eq(fills.tid, BigInt(shared)));
    expect(rows.map((r) => r.address).sort()).toEqual([A, B]);
    expect((await db.select().from(actions)).map((a) => `${a.address}:${a.side}`).sort()).toEqual([
      `${A}:long`,
      `${B}:short`,
    ]);
  });

  it("stores history but only alerts on recent live actions", async () => {
    const old = Date.now() - 3 * 3600_000;
    byAddress.set(A, [fill({ time: old }), fill({ time: old + 5000, startPosition: "1", side: "A", sz: "1" })]);

    await sync.sync(A, "backfill", 0);
    expect(await db.select().from(actions)).toHaveLength(2);
    expect(emitted).toHaveLength(0);
    expect(info.userFillsByTime).toHaveBeenCalledWith(A, 0, undefined, "background");

    const recent = Date.now();
    byAddress.get(A)!.push(fill({ time: recent }));
    await sync.sync(A, "sweep", old - 1);
    expect(emitted).toHaveLength(1);
  });

  it("does not alert on a sweep that finds a fill older than the alert horizon", async () => {
    byAddress.set(A, [fill({ time: Date.now() - 20 * 60_000 })]);
    const result = await sync.sync(A, "sweep", 0);
    expect(result.actions).toBe(1);
    expect(emitted).toHaveLength(0);
  });

  it("pages forward from the last timestamp when a page is full", async () => {
    const t = Date.now() - 100_000;
    const many = Array.from({ length: PAGE_SIZE + 5 }, (_, i) =>
      fill({ time: t + i, startPosition: String(i), sz: "1" }),
    );
    byAddress.set(A, many);

    const result = await sync.sync(A, "backfill", 0);
    expect(info.userFillsByTime).toHaveBeenCalledTimes(2);
    expect(info.userFillsByTime.mock.calls[1][1]).toBe(many[PAGE_SIZE - 1].time);
    expect(result.inserted).toBe(PAGE_SIZE + 5);
    expect(await db.select().from(fills)).toHaveLength(PAGE_SIZE + 5);
  });

  it("reports expected trade ids that Hyperliquid did not return yet", async () => {
    const t = Date.now();
    const present = fill({ time: t });
    byAddress.set(A, [present]);
    const result = await sync.sync(A, "live", t - 1000, [BigInt(present.tid), 999_999n]);
    expect(result.missingTids).toEqual([999_999n]);
  });

  it("queries the HIP-3 dex of a traded coin and sums equity across dexes", async () => {
    const accounts = new AccountStateService(info as unknown as HyperliquidInfoClient, db);
    const s = new FillSyncService(info as unknown as HyperliquidInfoClient, db, accounts, events);
    byAddress.set(A, [fill({ coin: "xyz:TSLA", side: "A", dir: "Open Short", time: Date.now() })]);

    await s.sync(A, "live", 0);
    expect(info.clearinghouseState).toHaveBeenCalledWith(A, "xyz", "live");
    expect(accounts.getEquityUsd(A)).toBe(1500);
    const [action] = await db.select().from(actions);
    expect(action).toMatchObject({ coin: "xyz:TSLA", kind: "open", side: "short", leverage: "3" });
  });

  it("a failed sync rejects to its caller only, and the next sync of that address still runs", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    info.userFillsByTime.mockRejectedValueOnce(new Error("Hyperliquid info request failed: 429"));
    await expect(sync.sync(A, "live", 0)).rejects.toThrow("429");
    byAddress.set(A, [fill({ time: Date.now() })]);
    await expect(sync.sync(A, "live", 0)).resolves.toMatchObject({ inserted: 1 });
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("runs overlapping syncs of one address one at a time, so the burst is classified once", async () => {
    const t = Date.now();
    byAddress.set(A, [fill({ time: t }), fill({ time: t + 1, startPosition: "1" })]);
    await Promise.all([sync.sync(A, "live", t - 1000), sync.sync(A, "sweep", t - 5000)]);
    expect(await db.select().from(actions)).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });
});
