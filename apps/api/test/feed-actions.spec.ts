import { AccountStateRepository } from "../src/watcher/account-state.repository.js";
import { testConfig } from "./config-test-utils.js";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { actions, fills } from "@trading-dashboard/shared/database";
import { asc } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { HlUserFill } from "../src/hyperliquid/types.js";
import { AccountStateService } from "../src/watcher/account-state.service.js";
import { classifyFills } from "../src/watcher/action-classifier.js";
import { ACTION_CREATED_EVENT } from "../src/watcher/action-created.event.js";
import { insertActions } from "../src/watcher/action-store.js";
import { FeedActionsService } from "../src/watcher/feed-actions.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";
import { FakeExchange } from "./fast-path-fixtures.js";

const A = "0xfa57";

describe("FeedActionsService (fast path) — real Postgres, fake Hyperliquid", () => {
  const db = getTestDb();
  let exchange: FakeExchange;
  let stateTime: number;
  let info: { clearinghouseState: ReturnType<typeof vi.fn>; userFillsByTime: ReturnType<typeof vi.fn> };
  let accounts: AccountStateService;
  let emitted: Array<typeof actions.$inferSelect>;
  let fast: FeedActionsService;

  beforeEach(async () => {
    await truncateAll(db);
    exchange = new FakeExchange(A);
    stateTime = 0;
    info = {
      clearinghouseState: vi.fn(async (_address: string, dex?: string) => exchange.stateAt(dex, stateTime)),
      userFillsByTime: vi.fn(),
    };
    const client = info as unknown as HyperliquidInfoClient;
    accounts = new AccountStateService(client, new AccountStateRepository(db));
    const events = new EventEmitter2();
    emitted = [];
    events.on(ACTION_CREATED_EVENT, (row) => emitted.push(row));
    fast = new FeedActionsService(testConfig(), db, accounts, events);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const shape = (d: { coin: string; kind: string; side: string; fillIds: bigint[]; notionalUsd: string; avgPx: string; ts: Date }) => ({
    coin: d.coin,
    kind: d.kind,
    side: d.side,
    fillIds: [...d.fillIds].sort(),
    notional: Number(d.notionalUsd),
    avgPx: Number(d.avgPx),
    ts: d.ts.getTime(),
  });

  it("classifies open, add, reduce, close and flip bursts exactly as the real fills would be", async () => {
    const t = Date.now() - 60_000;
    const bursts = [
      // Open across two orders 300 ms apart; the state read will hold the first only.
      [exchange.order("BTC", "B", ["0.4", "0.6"], t, "100"), exchange.order("BTC", "B", ["0.5"], t + 300, "101")],
      [exchange.order("BTC", "B", ["2"], t + 5_000, "102")], // add
      [exchange.order("BTC", "A", ["0.5", "0.5"], t + 10_000, "103")], // reduce
      [exchange.order("BTC", "A", ["2.5"], t + 15_000, "104")], // close
      [exchange.order("BTC", "B", ["1"], t + 20_000, "105")], // open again
      [exchange.order("BTC", "A", ["2", "1"], t + 25_000, "106")], // flip to short
    ];
    stateTime = t + 100;

    for (const orders of bursts) {
      await fast.process(A, orders.flatMap((o) => o.trades), 5);
    }

    const rows = await db.select().from(actions).orderBy(asc(actions.ts));
    const expected = bursts.flatMap((orders) =>
      classifyFills(A, orders.flatMap((o) => o.fills), () => 7),
    );
    expect(expected.map((d) => `${d.kind}:${d.side}`)).toEqual([
      "open:long",
      "add:long",
      "reduce:long",
      "close:long",
      "open:long",
      "flip:short",
    ]);
    expect(rows.map(shape)).toEqual(expected.map(shape));
    expect(rows.map((r) => r.leverage)).toEqual(["7", "7", "7", null, "7", "7"]);
    expect(emitted.map((r) => r.id)).toEqual(rows.map((r) => r.id));

    // One state read for the book, at live priority with the given rank;
    // never a fill query.
    expect(info.clearinghouseState).toHaveBeenCalledTimes(1);
    expect(info.clearinghouseState).toHaveBeenCalledWith(A, undefined, "live", 5);
    expect(info.userFillsByTime).not.toHaveBeenCalled();
  });

  it("gets its start from the book even when a restart missed earlier trades (add, not open)", async () => {
    const t = Date.now() - 30_000;
    exchange.order("ETH", "A", ["3"], t - 3_600_000); // an hour-old short
    const add = exchange.order("ETH", "A", ["1"], t);
    stateTime = t + 50; // includes the add already
    await fast.process(A, add.trades);
    const [row] = await db.select().from(actions);
    expect(row).toMatchObject({ coin: "ETH", kind: "add", side: "short" });
  });

  it("reads the dex again for the leverage of a position the state doesn't have yet", async () => {
    const t = Date.now() - 10_000;
    exchange.order("BTC", "B", ["1"], t - 60_000);
    exchange.order("BTC", "A", ["1"], t - 50_000);
    stateTime = t - 1; // flat
    await fast.process(A, exchange.order("SOL", "B", ["10"], t - 40_000).trades); // builds the book
    info.clearinghouseState.mockClear();

    const open = exchange.order("BTC", "A", ["2"], t);
    stateTime = t + 20; // the second read has the new position
    await fast.process(A, open.trades);
    const rows = await db.select().from(actions).orderBy(asc(actions.ts));
    expect(rows[rows.length - 1]).toMatchObject({ coin: "BTC", kind: "open", side: "short", leverage: "7" });
    expect(info.clearinghouseState).toHaveBeenCalledTimes(1);
  });

  it("queries a HIP-3 market's own dex", async () => {
    const t = Date.now();
    stateTime = t;
    await fast.process(A, exchange.order("xyz:TSLA", "A", ["5"], t).trades);
    expect(info.clearinghouseState).toHaveBeenCalledWith(A, "xyz", "live", undefined);
    const [row] = await db.select().from(actions);
    expect(row).toMatchObject({ coin: "xyz:TSLA", kind: "open", side: "short", leverage: "7" });
  });

  it("reads every dex of an address it has never read, so equity is the whole account's", async () => {
    await db.insert(fills).values({
      chain: "hyperliquid", tid: 1n, address: A, coin: "xyz:TSLA", side: "A", dir: "Open Short",
      px: "1", sz: "1", fee: "0", closedPnl: "0", hash: "0x", ts: new Date(), raw: {},
    });
    const t = Date.now();
    stateTime = t;
    await fast.process(A, exchange.order("BTC", "B", ["1"], t).trades);
    expect(info.clearinghouseState.mock.calls.map((c) => c[1] ?? "main").sort()).toEqual(["main", "xyz"]);
    expect(accounts.getEquityUsd(A)).toBe(2000);

    // Known from then on: a later burst on a new dex reads just that dex.
    info.clearinghouseState.mockClear();
    stateTime = t + 10;
    await fast.process(A, exchange.order("abc:GOLD", "B", ["1"], t + 10).trades);
    expect(info.clearinghouseState.mock.calls.map((c) => c[1])).toEqual(["abc"]);
  });

  it("makes no second action for replayed trades, or for trades a sweep already turned into one", async () => {
    const t = Date.now() - 5_000;
    stateTime = t - 1;
    const open = exchange.order("BTC", "B", ["1"], t);
    await fast.process(A, open.trades);
    await fast.process(A, open.trades); // the feed replays on resubscribe
    expect(await db.select().from(actions)).toHaveLength(1);

    // A sweep stored this one and made its action before the feed's copy
    // got here.
    const add = exchange.order("BTC", "B", ["1"], t + 2_000);
    await insertActions(db, A, classifyFills(A, add.fills as HlUserFill[]));
    await fast.process(A, add.trades);
    expect(await db.select().from(actions)).toHaveLength(2);
    expect(emitted).toHaveLength(1);

    // The book still moved with both: the next trade is a reduce from 2.
    const reduce = exchange.order("BTC", "A", ["0.5"], t + 4_000);
    await fast.process(A, reduce.trades);
    const rows = await db.select().from(actions).orderBy(asc(actions.ts));
    expect(rows[2]).toMatchObject({ kind: "reduce", side: "long" });
  });

  it("stores but doesn't alert on trades older than the alert horizon", async () => {
    const t = Date.now() - 5 * 60_000;
    stateTime = t - 1;
    await fast.process(A, exchange.order("BTC", "B", ["1"], t).trades);
    expect(await db.select().from(actions)).toHaveLength(1);
    expect(emitted).toHaveLength(0);
  });
});
