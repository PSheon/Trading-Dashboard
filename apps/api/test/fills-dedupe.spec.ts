import { fills } from "@trading-dashboard/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

describe("fills dedupe (W2) — real Postgres", () => {
  const db = getTestDb();

  beforeEach(async () => {
    await truncateAll(db);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("inserting the same (chain, address, tid) twice does not duplicate the row", async () => {
    const row = {
      chain: "hyperliquid" as const,
      tid: 123456789n,
      address: "0xabc",
      coin: "BTC",
      side: "B",
      dir: "Open Long",
      px: "60000",
      sz: "1",
      fee: "1",
      closedPnl: "0",
      hash: "0xhash1",
      ts: new Date("2026-01-01T00:00:00Z"),
      raw: { tid: 123456789 },
    };

    await db.insert(fills).values(row).onConflictDoNothing();
    await db.insert(fills).values(row).onConflictDoNothing();

    const rows = await db.select().from(fills);
    expect(rows).toHaveLength(1);
    expect(rows[0].tid).toBe(123456789n);
  });

  it("stores both counterparties of one trade (they share the tid)", async () => {
    const base = {
      chain: "hyperliquid" as const,
      tid: 77n,
      coin: "BTC",
      px: "60000",
      sz: "1",
      fee: "1",
      closedPnl: "0",
      hash: "0xhash",
      ts: new Date("2026-01-01T00:00:00Z"),
      raw: {},
    };
    await db.insert(fills).values({ ...base, address: "0xbuyer", side: "B", dir: "Open Long" }).onConflictDoNothing();
    await db.insert(fills).values({ ...base, address: "0xseller", side: "A", dir: "Open Short" }).onConflictDoNothing();
    expect(await db.select().from(fills)).toHaveLength(2);
  });

  it("tid=0 is a valid, distinct primary key value (observed live on Hyperliquid)", async () => {
    await db
      .insert(fills)
      .values({
        chain: "hyperliquid",
        tid: 0n,
        address: "0xabc",
        coin: "ETH",
        side: "B",
        dir: "Open Long",
        px: "2000",
        sz: "1",
        fee: "0.1",
        closedPnl: "0",
        hash: "0xhash0",
        ts: new Date("2026-01-01T00:00:00Z"),
        raw: {},
      })
      .onConflictDoNothing();

    const rows = await db.select().from(fills);
    expect(rows).toHaveLength(1);
    expect(rows[0].tid).toBe(0n);
  });

  it("different tids for the same address never collide", async () => {
    await db.insert(fills).values([
      {
        chain: "hyperliquid",
        tid: 1n,
        address: "0xabc",
        coin: "BTC",
        side: "B",
        dir: "Open Long",
        px: "60000",
        sz: "1",
        fee: "1",
        closedPnl: "0",
        hash: "0xh1",
        ts: new Date("2026-01-01T00:00:00Z"),
        raw: {},
      },
      {
        chain: "hyperliquid",
        tid: 2n,
        address: "0xabc",
        coin: "BTC",
        side: "A",
        dir: "Close Long",
        px: "61000",
        sz: "1",
        fee: "1",
        closedPnl: "1000",
        hash: "0xh2",
        ts: new Date("2026-01-01T00:01:00Z"),
        raw: {},
      },
    ]);

    const rows = await db.select().from(fills);
    expect(rows).toHaveLength(2);
  });
});
