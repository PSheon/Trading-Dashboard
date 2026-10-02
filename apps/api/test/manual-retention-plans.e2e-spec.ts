import { writeFileSync } from "node:fs";
import { RETENTION_DEFAULTS, RETENTION_TABLES } from "@trading-dashboard/shared/contracts";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { STATEMENTS } from "../src/retention/retention.repository.js";
import { retentionCutoffs } from "../src/retention/retention.service.js";
import { closeTestDb, getTestDb } from "./db-test-utils.js";

/**
 * MANUAL: the plan of every retention DELETE on a realistic row count, in an
 * isolated test database (it fills tables; nothing is kept: every delete is
 * rolled back). Not part of `pnpm test`.
 *
 *   E2E_RETENTION_PLANS=1 E2E_OUT=/tmp/retention-plans.txt TEST_DATABASE_ADMIN_URL=… \
 *     node scripts/test-api-isolated.mjs --config ./vitest.config.e2e.ts test/manual-retention-plans.e2e-spec.ts
 *
 * Sizes: 130 days of snapshots, 1.5 M position rows and 0.5 M equity rows.
 * That is about what 90 days hold at the dev database's rate of 2026-10-02
 * (15.6 k position rows and 4.1 k equity rows a day), with a month more to
 * delete, and enough for the planner to choose as it will in production.
 */
const run = process.env.E2E_RETENTION_PLANS === "1" ? describe : describe.skip;

run("retention delete plans", () => {
  it("every delete reads its batch through an index", async () => {
    const db = getTestDb();
    const now = new Date();
    await db.execute(sql`TRUNCATE position_snapshots, equity_snapshots, admin_audit_logs, alerts, notification_outbox, action_outbox, actions, copy_signal_outbox, copy_consumer_checkpoints, users RESTART IDENTITY CASCADE`);
    await db.execute(sql`INSERT INTO position_snapshots(address, coin, ts, szi)
      SELECT 'addr-' || (n % 100), 'C' || (n % 5), now() - (n / 40) * interval '5 minutes' - (n % 40) * interval '1 millisecond', 1 FROM generate_series(1, 1500000) n`);
    await db.execute(sql`INSERT INTO equity_snapshots(address, ts, account_value)
      SELECT 'addr-' || (n % 100), now() - (n / 13) * interval '5 minutes' - (n % 13) * interval '1 millisecond', 1 FROM generate_series(1, 500000) n`);
    await db.execute(sql`INSERT INTO admin_audit_logs(actor_kind, event, target, created_at)
      SELECT 'user', CASE WHEN n % 50 = 0 THEN 'user.delete' ELSE 'settings.update' END, 't', now() - n * interval '10 minutes' FROM generate_series(1, 100000) n`);
    await db.execute(sql`INSERT INTO users(privy_user_id) SELECT 'did:privy:plan-' || n FROM generate_series(1, 200) n`);
    await db.execute(sql`INSERT INTO actions(address, coin, kind, side, notional_usd, avg_px, fill_ids, ts)
      SELECT 'addr-' || (n % 100), 'BTC', 'open', 'long', 1, 1, '{}', now() - n * interval '20 seconds' FROM generate_series(1, 300000) n`);
    await db.execute(sql`INSERT INTO action_outbox(action_id, status, available_at)
      SELECT id, CASE WHEN id % 1000 = 0 THEN 'failed' ELSE 'done' END, ts FROM actions`);
    await db.execute(sql`INSERT INTO notification_outbox(action_id, user_id, payload_json, status, available_at, created_at)
      SELECT a.id, 1 + (a.id % 200), '{}', 'sent', a.ts, a.ts FROM actions a WHERE a.id % 2 = 0`);
    await db.execute(sql`INSERT INTO alerts(user_id, address, coin, action_id, payload_json, sent_at, send_status)
      SELECT 1 + (a.id % 200), a.address, a.coin, a.id, '{}', a.ts, 'sent' FROM actions a WHERE a.id % 2 = 0`);
    await db.execute(sql`INSERT INTO copy_signal_outbox(address, tid, fill_time, status, created_at, processed_at)
      SELECT 'addr-' || (n % 20), n, now() - (200000 - n) * interval '30 seconds', 'done', now() - (200000 - n) * interval '30 seconds', now() - (200000 - n) * interval '30 seconds' FROM generate_series(1, 200000) n`);
    await db.execute(sql`INSERT INTO copy_consumer_checkpoints(consumer, last_outbox_id) VALUES ('paper', 200000)`);
    await db.execute(sql`ANALYZE`);

    const cutoffs = retentionCutoffs(RETENTION_DEFAULTS, now);
    const lines: string[] = [];
    for (const table of RETENTION_TABLES) {
      const real = table === "account_deletion_records" ? "admin_audit_logs" : table;
      const total = Number((await db.execute(sql.raw(`select count(*)::int as n from ${real}`))).rows[0].n);
      let plan: string[] = [];
      let deleted = 0;
      await db.transaction(async (tx) => {
        const result = await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING ON) ${STATEMENTS[table](cutoffs[table], 2000)}`);
        plan = result.rows.map((r) => String((r as Record<string, unknown>)["QUERY PLAN"]));
        deleted = Number(/(?:Tid Scan|Index Scan using \w+_pkey) on .*rows=(\d+)/.exec(plan.filter((l) => l.startsWith("  ->")).join("\n"))?.[1] ?? -1);
        tx.rollback();
      }).catch((error: unknown) => { if (!/Rollback/i.test(String(error))) throw error; });
      lines.push(`## ${table} (${total.toLocaleString("en-US")} rows in ${real}, cutoff ${cutoffs[table].toISOString().slice(0, 10)})`, "", "```", ...plan, "```", "");
      // The batch is found through an index; the big tables are never read whole.
      const text = plan.join("\n");
      expect(text, table).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
      expect(text, table).not.toMatch(new RegExp(`Seq Scan on ${real}\\b`));
      expect(text, table).not.toMatch(/Sort Method/);
      lines.push(`Rows deleted by this statement: ${deleted}`, "");
    }
    if (process.env.E2E_OUT) writeFileSync(process.env.E2E_OUT, lines.join("\n"));
    await closeTestDb();
  }, 600_000);
});
