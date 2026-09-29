import { actions, fills, leaders } from "@trading-dashboard/shared";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type {
  HlClearinghouseStateResponse,
  HlUserFill,
} from "../src/hyperliquid/types.js";
import { ACTION_CREATED_EVENT } from "../src/watcher/action-created.event.js";
import { WatcherService } from "../src/watcher/watcher.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const ADDRESS = "0xwatchertest";

/** `runPollCycle` timestamps each poll with a real `Date.now()` (deliberately
 * — production polls are naturally >=20s apart per WATCHER_POLL_INTERVAL_SECONDS,
 * so wall-clock resolution is never an issue there). In a test calling two
 * cycles back-to-back, they can land in the same millisecond, which would
 * make the second cycle's fill-fetch window collapse to zero width. A tiny
 * real delay between cycles keeps these tests honest without adding
 * artificial clock-injection machinery to the production code for an edge
 * case that doesn't occur at real poll intervals. */
function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chState(positions: Array<{ coin: string; szi: string; entryPx?: string; leverage?: number; marginMode?: string }>): HlClearinghouseStateResponse {
  return {
    assetPositions: positions.map((p) => ({
      type: "oneWay",
      position: {
        coin: p.coin,
        szi: p.szi,
        entryPx: p.entryPx,
        leverage: { type: p.marginMode ?? "cross", value: p.leverage ?? 10 },
        marginUsed: "100",
        unrealizedPnl: "0",
      },
    })),
    marginSummary: { accountValue: "10000", totalMarginUsed: "100", totalNtlPos: "1000", totalRawUsd: "1000" },
    crossMarginSummary: { accountValue: "10000", totalMarginUsed: "100", totalNtlPos: "1000", totalRawUsd: "1000" },
    withdrawable: "9900",
    time: Date.now(),
  };
}

let tid = 1000;
function hlFill(overrides: Partial<HlUserFill>): HlUserFill {
  return {
    coin: "BTC",
    px: "60000",
    sz: "1",
    side: "B",
    time: Date.now(),
    dir: "Open Long",
    closedPnl: "0",
    hash: "0xabc",
    oid: 1,
    crossed: true,
    fee: "1",
    tid: tid++,
    ...overrides,
  };
}

describe("WatcherService.runPollCycle — real Postgres, mocked Hyperliquid client", () => {
  const db = getTestDb();

  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("detects a new position, fetches the fill window, and writes fills + a single 'open' action", async () => {
    await db.insert(leaders).values({ chain: "hyperliquid", address: ADDRESS, active: true, tier: "B" });

    const clearinghouseState = vi
      .fn()
      .mockResolvedValueOnce(chState([])) // cycle 1: flat, nothing to diff yet
      .mockResolvedValueOnce(chState([{ coin: "BTC", szi: "1", entryPx: "60000" }])); // cycle 2: opened
    const userFillsByTime = vi.fn().mockResolvedValueOnce([
      hlFill({ dir: "Open Long", px: "60000", sz: "1" }),
    ]);

    const fakeInfo = { clearinghouseState, userFillsByTime } as unknown as HyperliquidInfoClient;
    const watcher = new WatcherService(fakeInfo, db);

    await watcher.runPollCycle(); // seeds state, no delta
    expect(userFillsByTime).not.toHaveBeenCalled();

    await tick();
    await watcher.runPollCycle(); // detects the new BTC position
    expect(userFillsByTime).toHaveBeenCalledTimes(1);

    const insertedFills = await db.select().from(fills).where(eq(fills.address, ADDRESS));
    expect(insertedFills).toHaveLength(1);

    const insertedActions = await db.select().from(actions).where(eq(actions.address, ADDRESS));
    expect(insertedActions).toHaveLength(1);
    expect(insertedActions[0]).toMatchObject({ kind: "open", side: "long", coin: "BTC" });

    const heartbeat = watcher.getHeartbeat();
    expect(heartbeat.lastFillAt).not.toBeNull();
    expect(heartbeat.cyclesCompleted).toBe(2);
  });

  it("emits one 'action.created' event per persisted action, carrying the full DB row (id included) — the Rules trigger mechanism", async () => {
    await db.insert(leaders).values({ chain: "hyperliquid", address: ADDRESS, active: true, tier: "B" });

    const clearinghouseState = vi
      .fn()
      .mockResolvedValueOnce(chState([]))
      .mockResolvedValueOnce(chState([{ coin: "BTC", szi: "1", entryPx: "60000" }]));
    const userFillsByTime = vi
      .fn()
      .mockResolvedValueOnce([hlFill({ dir: "Open Long", px: "60000", sz: "1" })]);
    const fakeInfo = { clearinghouseState, userFillsByTime } as unknown as HyperliquidInfoClient;

    const emitter = new EventEmitter2();
    const received: unknown[] = [];
    emitter.on(ACTION_CREATED_EVENT, (payload) => received.push(payload));

    const watcher = new WatcherService(fakeInfo, db, emitter);
    await watcher.runPollCycle();
    await tick();
    await watcher.runPollCycle();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: "open", coin: "BTC", address: ADDRESS });
    expect((received[0] as { id: unknown }).id).toBeDefined();
  });

  it("getEquityUsd reads accountValue from the cached clearinghouseState, and is null before any poll cycle completes", async () => {
    await db.insert(leaders).values({ chain: "hyperliquid", address: ADDRESS, active: true, tier: "B" });
    const clearinghouseState = vi.fn().mockResolvedValueOnce(chState([]));
    const fakeInfo = { clearinghouseState, userFillsByTime: vi.fn() } as unknown as HyperliquidInfoClient;
    const watcher = new WatcherService(fakeInfo, db);

    expect(watcher.getEquityUsd(ADDRESS)).toBeNull();
    await watcher.runPollCycle();
    expect(watcher.getEquityUsd(ADDRESS)).toBe(10000); // chState() helper's fixed marginSummary.accountValue
  });

  it("classifies a follow-up fill as 'add' once a position already exists", async () => {
    await db.insert(leaders).values({ chain: "hyperliquid", address: ADDRESS, active: true, tier: "B" });

    // Cycle 1: flat (seeds state, no in-memory history yet — nothing to
    // diff, matches "fall back sensibly on first-ever poll" for an address
    // with no prior fills at all either). Cycle 2: opens. Cycle 3: grows
    // the same position, which must classify as 'add', not 'open' again.
    const clearinghouseState = vi
      .fn()
      .mockResolvedValueOnce(chState([]))
      .mockResolvedValueOnce(chState([{ coin: "BTC", szi: "1", entryPx: "60000" }]))
      .mockResolvedValueOnce(chState([{ coin: "BTC", szi: "2", entryPx: "60500" }]));
    const userFillsByTime = vi
      .fn()
      .mockResolvedValueOnce([hlFill({ dir: "Open Long", px: "60000", sz: "1" })])
      .mockResolvedValueOnce([hlFill({ dir: "Open Long", px: "61000", sz: "1" })]);

    const fakeInfo = { clearinghouseState, userFillsByTime } as unknown as HyperliquidInfoClient;
    const watcher = new WatcherService(fakeInfo, db);

    await watcher.runPollCycle(); // flat, seeds state
    await tick();
    await watcher.runPollCycle(); // opens a 1-BTC long
    await tick();
    await watcher.runPollCycle(); // grows to 2 BTC -> 'add'

    const insertedActions = await db
      .select()
      .from(actions)
      .where(eq(actions.address, ADDRESS))
      .orderBy(actions.ts);
    expect(insertedActions).toHaveLength(2);
    expect(insertedActions[0].kind).toBe("open");
    expect(insertedActions[1].kind).toBe("add");
  });

  it("only polls active leaders and re-reads the leader list fresh every cycle (A2/A3)", async () => {
    await db.insert(leaders).values([
      { chain: "hyperliquid", address: "0xactive", active: true, tier: "B" },
      { chain: "hyperliquid", address: "0xinactive", active: false, tier: "B" },
    ]);

    const clearinghouseState = vi.fn().mockResolvedValue(chState([]));
    const userFillsByTime = vi.fn().mockResolvedValue([]);
    const fakeInfo = { clearinghouseState, userFillsByTime } as unknown as HyperliquidInfoClient;
    const watcher = new WatcherService(fakeInfo, db);

    await watcher.runPollCycle();
    expect(clearinghouseState).toHaveBeenCalledTimes(1);
    expect(clearinghouseState).toHaveBeenCalledWith("0xactive");

    // A3: flip active=true and confirm it's picked up on the very next cycle.
    await db
      .update(leaders)
      .set({ active: true })
      .where(and(eq(leaders.chain, "hyperliquid"), eq(leaders.address, "0xinactive")));

    await watcher.runPollCycle();
    expect(clearinghouseState).toHaveBeenCalledTimes(3); // 1 (cycle1) + 2 (cycle2, both active now)
  });

  it("falls back to the latest fill already on file when an address has no in-memory poll history", async () => {
    await db.insert(leaders).values({ chain: "hyperliquid", address: ADDRESS, active: true, tier: "B" });
    const backfilledFillTs = new Date("2026-01-01T00:00:00Z");
    await db.insert(fills).values({
      chain: "hyperliquid",
      tid: 1n,
      address: ADDRESS,
      coin: "BTC",
      side: "B",
      dir: "Open Long",
      px: "50000",
      sz: "1",
      fee: "1",
      closedPnl: "0",
      hash: "0xbackfill",
      ts: backfilledFillTs,
      raw: {},
    });

    // First-ever poll of this process sees an already-open position (e.g.
    // Railway just restarted, or this is the address's very first regular
    // poll right after A5 backfill finished) — there is no in-memory prior
    // state at all, so the delta ("no prior state" -> "has a position")
    // must fall back to the latest backfilled fill's timestamp for the
    // window start rather than fetching an unbounded window.
    const clearinghouseState = vi
      .fn()
      .mockResolvedValueOnce(chState([{ coin: "BTC", szi: "1", entryPx: "50000" }]));
    const userFillsByTime = vi.fn().mockResolvedValueOnce([
      hlFill({ dir: "Open Long", px: "50000", sz: "1", time: backfilledFillTs.getTime() + 5000 }),
    ]);
    const fakeInfo = { clearinghouseState, userFillsByTime } as unknown as HyperliquidInfoClient;
    const watcher = new WatcherService(fakeInfo, db);

    await watcher.runPollCycle();

    expect(userFillsByTime).toHaveBeenCalledTimes(1);
    const [, startTime] = userFillsByTime.mock.calls[0];
    expect(startTime).toBe(backfilledFillTs.getTime() + 1);
  });
});
