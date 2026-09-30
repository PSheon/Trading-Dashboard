import { ActionsRepository } from "../src/api/actions/actions.repository.js";
import { actions } from "@trading-dashboard/shared/database";
import { actionsFeedQuerySchema } from "@trading-dashboard/shared/contracts";
import { afterAll, beforeEach, expect, it } from "vitest";
import { ActionsService } from "../src/api/actions/actions.service.js";
import { closeTestDb, getTestDb, truncateAll } from "./db-test-utils.js";

const db = getTestDb();
beforeEach(() => truncateAll(db));
afterAll(closeTestDb);

it("paginates equal timestamps without skips or duplicates and retains legacy before", async () => {
  const ts = new Date("2026-01-01T00:00:00Z");
  const rows = await db.insert(actions).values(Array.from({ length: 5 }, (_, i) => ({
    chain: "hyperliquid" as const, address: "0x" + "ab".repeat(20), coin: "BTC",
    kind: "open" as const, side: "long", notionalUsd: "10", avgPx: "1", fillIds: [],
    ts: i === 0 ? new Date(ts.getTime() - 1000) : ts,
  }))).returning();
  const service = new ActionsService(new ActionsRepository(db));
  const ids: string[] = [];
  let query = actionsFeedQuerySchema.parse({ limit: 2 });
  for (let i = 0; i < 4; i++) {
    const page = await service.findFeed(query);
    ids.push(...page.map((r) => String(r.id)));
    if (page.length < 2) break;
    const last = page.at(-1)!;
    query = actionsFeedQuerySchema.parse({ limit: 2, before: last.ts, beforeId: String(last.id) });
  }
  expect(ids).toEqual(rows.map((r) => String(r.id)).reverse());
  expect((await service.findFeed(actionsFeedQuerySchema.parse({ before: ts }))).map((r) => r.id)).toEqual([rows[0].id]);
});

it("rejects unpaired, invalid and overflowing cursor ids", () => {
  for (const query of [{ beforeId: "1" }, ...["0", "-1", "1.5", "abc", "9223372036854775808"].map((beforeId) => ({ before: "2026-01-01", beforeId }))]) {
    expect(actionsFeedQuerySchema.safeParse(query).success).toBe(false);
  }
});
