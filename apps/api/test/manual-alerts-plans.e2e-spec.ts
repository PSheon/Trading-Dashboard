import { writeFileSync } from "node:fs";
import { sql, type SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { closeTestDb, getTestDb } from "./db-test-utils.js";

/**
 * MANUAL: the plans of the two `alerts` queries review finding 50 names, on
 * a realistic row count, before and after migration 0027's indexes, in an
 * isolated test database. Not part of `pnpm test`.
 *
 *   E2E_ALERTS_PLANS=1 E2E_OUT=/tmp/alerts-plans.txt TEST_DATABASE_ADMIN_URL=… \
 *     node scripts/test-api-isolated.mjs --config ./vitest.config.e2e.ts test/manual-alerts-plans.e2e-spec.ts
 *
 * 1,000,000 alerts: 30 days at about 33 k a day (2,000 users alerted on 400
 * traders' actions), which is what the 30-day retention keeps at that load.
 * "Before" is the same database with the two new indexes dropped inside a
 * transaction that is rolled back.
 */
const run = process.env.E2E_ALERTS_PLANS === "1" ? describe : describe.skip;

run("alerts query plans", () => {
  it("delivery and rule evaluation read alerts through an index", async () => {
    const db = getTestDb();
    await db.execute(sql`TRUNCATE alerts, notification_outbox, action_outbox, actions, alert_rules, users RESTART IDENTITY CASCADE`);
    await db.execute(sql`INSERT INTO users(privy_user_id) SELECT 'did:privy:plan-' || n FROM generate_series(1, 2000) n`);
    await db.execute(sql`INSERT INTO alert_rules(scope, kind, params_json, cooldown_s, tiers) VALUES ('address', 'R1', '{}', 600, '{A,B}'), ('address', 'R2', '{}', 600, '{A,B}'), ('address', 'R3', '{}', 600, '{A,B}')`);
    await db.execute(sql`INSERT INTO actions(address, coin, kind, side, notional_usd, avg_px, fill_ids, ts)
      SELECT 'addr-' || (n % 400), (ARRAY['BTC','ETH','SOL','HYPE','DOGE'])[1 + n % 5], 'open', 'long', 1, 1, '{}', now() - n * interval '13 seconds' FROM generate_series(1, 200000) n`);
    // Five recipients an action; a fifth of the rows are admin rule alerts.
    await db.execute(sql`INSERT INTO alerts(user_id, rule_id, address, coin, action_id, payload_json, sent_at, send_status)
      SELECT 1 + ((a.id * 7 + k) % 2000), CASE WHEN k = 0 THEN 1 + (a.id % 3) END, a.address, a.coin, a.id, '{}', a.ts, 'sent'
      FROM actions a, generate_series(0, 4) k`);
    await db.execute(sql`ANALYZE`);
    const total = Number((await db.execute(sql`select count(*)::int as n from alerts`)).rows[0]!.n);
    expect(total).toBe(1_000_000);

    const queries: Array<{ name: string; where: string; statement: SQL }> = [
      {
        name: "Delivery: NotifyRepository.recordDelivery (once per message sent)",
        where: "apps/api/src/notify/notify.repository.ts",
        statement: sql`UPDATE alerts SET send_status = 'sent', sent_at = now(), payload_json = '{}' WHERE action_id = 100000 AND user_id = ${1 + ((100000 * 7 + 2) % 2000)}`,
      },
      {
        name: "Rule evaluation: RulesRepository.lastSent (every action of an imported leader)",
        where: "apps/api/src/rules/rules.repository.ts",
        statement: sql`SELECT user_id, rule_id, max(sent_at) FROM alerts WHERE user_id IN (1, 2, 3) AND rule_id IN (1, 2, 3) AND address = 'addr-7' AND coin = 'BTC' GROUP BY user_id, rule_id`,
      },
    ];
    const explain = async (statement: SQL, dropIndexes: boolean): Promise<string[]> => {
      let plan: string[] = [];
      await db.transaction(async (tx) => {
        if (dropIndexes) await tx.execute(sql`DROP INDEX alerts_action_user_idx, alerts_cooldown_idx`);
        const result = await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${statement}`);
        plan = result.rows.map((r) => String((r as Record<string, unknown>)["QUERY PLAN"]));
        tx.rollback();
      }).catch((error: unknown) => { if (!/Rollback/i.test(String(error))) throw error; });
      return plan;
    };
    const lines: string[] = [`alerts: ${total.toLocaleString("en-US")} rows`, ""];
    for (const q of queries) {
      const before = await explain(q.statement, true);
      const after = await explain(q.statement, false);
      lines.push(`## ${q.name}`, `(${q.where})`, "", "Before (only alerts_pkey, alerts_sent_at_idx and alerts_unsent_idx):", "```", ...before, "```", "", "After (migration 0027):", "```", ...after, "```", "");
      expect(before.join("\n"), q.name).toMatch(/Seq Scan on alerts/);
      expect(after.join("\n"), q.name).not.toMatch(/Seq Scan on alerts/);
      expect(after.join("\n"), q.name).toMatch(/alerts_action_user_idx|alerts_cooldown_idx/);
      const ms = (plan: string[]) => Number(/Execution Time: ([\d.]+) ms/.exec(plan.join("\n"))?.[1]);
      // Well inside the pool's 15 s statement timeout either way at this size; the index is what keeps it there.
      expect(ms(after)).toBeLessThan(ms(before));
      expect(ms(after)).toBeLessThan(5);
    }
    if (process.env.E2E_OUT) writeFileSync(process.env.E2E_OUT, lines.join("\n"));
    await closeTestDb();
  }, 600_000);
});
