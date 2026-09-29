import { and, eq } from "drizzle-orm";
import { leaderListItems, leaderLists, leaders } from "@trading-dashboard/shared";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BackfillService } from "../src/watcher/backfill.service.js";
import { ImportService } from "../src/import/import.service.js";
import type { FillSyncService } from "../src/watcher/fill-sync.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

describe("ImportService (A1/A2/A5) — real Postgres", () => {
  const db = getTestDb();
  const backfill = new BackfillService({} as FillSyncService);
  const triggerSpy = vi.spyOn(backfill, "trigger").mockImplementation(() => {});
  const importService = new ImportService(db, backfill);

  beforeEach(async () => {
    await truncateAll(db);
    triggerSpy.mockClear();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("imports address+rank+extra columns into leader_lists/leader_list_items/leaders with correct tiering", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      address: `0x${(i + 1).toString().padStart(4, "0")}`,
      rank: i + 1,
      pnl30d: 1000 * (i + 1),
      note: "copydog export",
    }));

    const result = await importService.importLeaderList({
      source: "copydog",
      fileName: "top100.csv",
      rows,
    });

    expect(result.itemCount).toBe(25);
    expect(result.newAddresses).toHaveLength(25);

    const items = await db.select().from(leaderListItems).where(eq(leaderListItems.listId, result.listId));
    expect(items).toHaveLength(25);
    const item1 = items.find((i) => i.address === "0x0001");
    expect(item1?.rank).toBe(1);
    expect(item1?.statsJson).toMatchObject({ pnl30d: 1000, note: "copydog export" });

    const allLeaders = await db.select().from(leaders);
    expect(allLeaders).toHaveLength(25);

    const rank1 = allLeaders.find((l) => l.address === "0x0001");
    expect(rank1?.tier).toBe("A"); // rank <= 20
    expect(rank1?.active).toBe(true);
    expect(rank1?.chain).toBe("hyperliquid");

    const rank21 = allLeaders.find((l) => l.address === (`0x${(21).toString().padStart(4, "0")}`));
    expect(rank21?.tier).toBe("B"); // rank > 20

    // A5: backfill fired for every genuinely new address.
    expect(triggerSpy).toHaveBeenCalledTimes(25);
  });

  it("rejects rows missing address or rank instead of silently dropping them", async () => {
    await expect(
      importService.importLeaderList({
        source: "copydog",
        fileName: "bad.csv",
        rows: [
          { address: "0xaaa", rank: 1 },
          { rank: 2 }, // missing address
          { address: "0xccc" }, // missing rank
        ],
      }),
    ).rejects.toThrow();

    const lists = await db.select().from(leaderLists);
    expect(lists).toHaveLength(0); // nothing partially committed
  });

  it("re-importing an address does not clobber a manually-edited tier/active/label (A3 vs A2)", async () => {
    await importService.importLeaderList({
      source: "copydog",
      fileName: "v1.csv",
      rows: [{ address: "0xmanual", rank: 5 }], // rank <= 20 -> tier A on first import
    });

    triggerSpy.mockClear(); // only care about backfill calls from the re-import below

    // Simulate an A3 manual edit: demote to C, deactivate, label it.
    await db
      .update(leaders)
      .set({ tier: "C", active: false, label: "watch closely" })
      .where(and(eq(leaders.chain, "hyperliquid"), eq(leaders.address, "0xmanual")));

    // Re-import the same address at a still <=20 rank — A2 must not touch
    // the manually-edited fields on an existing leader.
    const result = await importService.importLeaderList({
      source: "copydog",
      fileName: "v2.csv",
      rows: [{ address: "0xmanual", rank: 2 }],
    });

    expect(result.newAddresses).toHaveLength(0); // not "new" the second time

    const [row] = await db
      .select()
      .from(leaders)
      .where(and(eq(leaders.chain, "hyperliquid"), eq(leaders.address, "0xmanual")));
    expect(row.tier).toBe("C");
    expect(row.active).toBe(false);
    expect(row.label).toBe("watch closely");

    // And A5 backfill must not re-fire for an address that wasn't new.
    expect(triggerSpy).not.toHaveBeenCalledWith("0xmanual");
  });

  it("turns a favorited leader into an imported one, reactivating it, without re-backfilling", async () => {
    await db.insert(leaders).values([
      { chain: "hyperliquid", address: "0xfav", source: "favorite", active: false, tier: "B" },
      { chain: "hyperliquid", address: "0xoff", source: "import", active: false, tier: "C" },
    ]);

    const result = await importService.importLeaderList({
      source: "copydog",
      fileName: "v3.csv",
      rows: [
        { address: "0xfav", rank: 5 },
        { address: "0xoff", rank: 6 },
      ],
    });

    expect(result.newAddresses).toHaveLength(0);
    const rows = await db.select().from(leaders);
    const byAddress = new Map(rows.map((r) => [r.address, r]));
    expect(byAddress.get("0xfav")).toMatchObject({ source: "import", active: true, tier: "B" });
    // An admin's manual deactivation of an imported leader still survives.
    expect(byAddress.get("0xoff")).toMatchObject({ source: "import", active: false, tier: "C" });
    expect(triggerSpy).not.toHaveBeenCalled();
  });
});
