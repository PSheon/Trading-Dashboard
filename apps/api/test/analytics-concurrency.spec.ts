import { it, expect } from "vitest";
import { TradeAnalyticsRepository } from "../src/traders/trade-analytics.repository.js";
import { getTestDb, truncateAll, closeTestDb } from "./db-test-utils.js";
import { sql } from "drizzle-orm";
it("rejects stale analytics writers after another process commits", async () => {
 const db = getTestDb();
 await truncateAll(db);
 const repo = new TradeAnalyticsRepository(db);
 const address = '0x'+'a'.repeat(40);
 try {
  await repo.transaction(async tx => { await repo.assertState(tx,address,undefined); });
  await db.execute(sql`INSERT INTO trader_analytics (chain,address,source,computed_at,summary,classification) VALUES ('hyperliquid',${address},'tracked',now(),'{}','{}')`);
  await expect(repo.transaction(tx => repo.assertState(tx,address,undefined))).rejects.toThrow();
 } finally { await closeTestDb(); }
});
