import { copyOrders, copySignalOutbox, copyStrategies } from "@trading-dashboard/shared/database";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { CopyRepository } from "../src/copy/copy.repository.js";
import { closeTestDb, getTestDb, insertUser, truncateAll } from "./db-test-utils.js";

const db = getTestDb();
const repository = new CopyRepository(db);
const ADDRESS = `0x${"ab".repeat(20)}`;
beforeEach(async () => { await truncateAll(db); });
afterEach(() => vi.useRealTimers());
afterAll(closeTestDb);
function drift(milliseconds: number) { const now = Date.now(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now + milliseconds); }
it("does not delay a committed signal because the worker clock is behind Postgres", async () => {
  const [row] = await db.insert(copySignalOutbox).values({ address: ADDRESS, tid: 1n, fillTime: new Date() }).returning();
  drift(-300_000);
  expect((await repository.pendingOutbox(10)).map((item) => item.id)).toEqual([row!.id]);
});
it("does not consume a backed-off signal early when the worker clock is ahead", async () => {
  await db.insert(copySignalOutbox).values({ address: ADDRESS, tid: 1n, fillTime: new Date(), availableAt: sql`now() + interval '2 minutes'` });
  drift(300_000);
  expect(await repository.pendingOutbox(10)).toEqual([]);
});
it("keeps the per-minute cap based on the same clock that stamps orders", async () => {
  const user = await insertUser(db);
  const [strategy] = await db.insert(copyStrategies).values({ userId: user.id, leaderAddress: ADDRESS, allocated: "1000", cash: "1000", activatedAt: new Date() }).returning();
  await db.insert(copyOrders).values({ cloid: `0x${"11".repeat(16)}`, strategyId: strategy!.id, userId: user.id, strategyVersion: 1, riskPolicyVersion: 0, leaderAddress: ADDRESS, coin: "BTC", leg: "open", side: "B", reduceOnly: false, size: "0.1", signalPx: "100000", signalTime: new Date(), signalTids: [], status: "filled", controlRevisions: { platform: 0, user: 0, strategy: 0 } });
  drift(300_000);
  expect(await db.transaction((tx) => repository.ordersLastMinute(tx, strategy!.id))).toBe(1);
});
