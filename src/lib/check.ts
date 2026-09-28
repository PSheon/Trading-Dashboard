// Integrity checks over the warehouse. Each is a query that should find
// nothing; `check` runs them all and reports which found something.

import { queryRows } from "./db";
import { dayRange } from "./snapshots";
import type { Warehouse } from "./store";
import { loadWallets, pendingIngest } from "./wallets";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function count(sql: string): Promise<number> {
  const [row] = await queryRows(sql);
  return Number(Object.values(row)[0] ?? 0);
}

export async function runChecks(wh: Warehouse): Promise<{ ok: boolean; checks: CheckResult[] }> {
  const trades = wh.relation("trades");
  const transfers = wh.relation("token_transfers");
  const lots = wh.relation("lots");
  const positions = wh.relation("positions");
  const wallets = wh.relation("wallets");
  const checks: CheckResult[] = [];
  const add = (name: string, bad: number, what: string) =>
    checks.push({ name, ok: bad === 0, detail: bad === 0 ? "ok" : `${bad} ${what}` });

  add(
    "trades_unique",
    await count(`SELECT count(*) - count(DISTINCT (tx_sig, wallet, mint)) FROM ${trades}`),
    "duplicate (tx_sig, wallet, mint)",
  );
  add(
    "transfers_unique",
    await count(`SELECT count(*) - count(DISTINCT (tx_sig, wallet, mint, direction)) FROM ${transfers}`),
    "duplicate (tx_sig, wallet, mint, direction)",
  );
  add(
    "lots_add_up",
    await count(`
      SELECT count(*) FROM ${positions} p
      LEFT JOIN (
        SELECT wallet, mint, position_seq, count(*) AS n, sum(coalesce(cost_lamports, 0)) AS cost,
               sum(realized_pnl_lamports) AS pnl
        FROM ${lots} GROUP BY ALL
      ) l USING (wallet, mint, position_seq)
      WHERE l.n IS DISTINCT FROM p.lots OR l.cost IS DISTINCT FROM p.cost_lamports
         OR (p.complete AND l.pnl IS DISTINCT FROM p.realized_pnl_lamports)`),
    "positions whose lots do not add up",
  );
  add(
    "wallets_registered",
    await count(`
      SELECT count(DISTINCT wallet) FROM (
        SELECT wallet FROM ${trades} UNION ALL SELECT wallet FROM ${transfers} UNION ALL SELECT wallet FROM ${positions}
      ) WHERE wallet NOT IN (SELECT address FROM ${wallets})`),
    "wallets in derived tables but not in the registry",
  );

  const days = wh.days("wallet_metrics_daily").sort();
  const gaps = days.length ? dayRange(days[0], days.at(-1)!).filter((d) => !days.includes(d)) : [];
  checks.push({
    name: "snapshots_contiguous",
    ok: gaps.length === 0,
    detail: gaps.length ? `missing ${gaps.length} day(s), first ${gaps[0]}` : days.length ? `${days[0]} … ${days.at(-1)}` : "no snapshots",
  });
  add("snapshots_fresh", await count(`SELECT count(*) FROM ${wh.relation("snapshot_dirty")}`), "wallets with stale snapshots");
  add("ingest_caught_up", pendingIngest(await loadWallets(wh)).length, "wallets fetched but not ingested");
  return { ok: checks.every((c) => c.ok), checks };
}
