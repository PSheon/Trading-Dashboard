// Point-in-time wallet metrics.
//
// Every number is a function of what happened strictly before `asOfDate`
// 00:00 UTC. The only way in is `compute`, which cuts every input at that bound
// before anything else touches it. This module never reads files: callers hand
// it SQL relations (the warehouse's, or a test's).
//
// Sums are taken in integer lamports and converted at the end, so recomputing a
// day gives the same bits regardless of row order.

import { lit, queryRows } from "./db";
import { fromDb, SCHEMAS } from "./store";

export interface Metrics {
  as_of_date: string;
  wallet: string;
  trade_count: number;
  token_count: number;
  realized_pnl_sol: number;
  fees_sol: number;
  win_rate: number | null;
  pnl_concentration: number | null;
  median_hold_seconds: number | null;
  median_entry_age_seconds: number | null;
  pre_graduation_ratio: number | null;
  tx_per_active_hour: number | null;
  last_active_at: number;
  max_drawdown_sol: number | null;
  unknown_cost_ratio: number | null;
}

export function bound(asOfDate: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw new Error(`not a date: ${asOfDate}`);
  return Date.parse(`${asOfDate}T00:00:00Z`) / 1000;
}

export const tradesAsOf = (trades: string, asOf: number) =>
  `(SELECT * FROM ${trades} WHERE block_time < ${asOf})`;

// A position closed after as_of was still open then, whatever its lots did.
export const positionsClosedAsOf = (positions: string, asOf: number) =>
  `(SELECT * FROM ${positions} WHERE closed_at IS NOT NULL AND closed_at < ${asOf})`;

// A graduation after as_of had not happened yet; knowing it would is look-ahead.
export const tokensKnownAsOf = (tokens: string, asOf: number) =>
  `(SELECT mint, created_at, CASE WHEN graduated_at < ${asOf} THEN graduated_at END AS graduated_at
    FROM ${tokens} WHERE created_at < ${asOf})`;

const NO_TOKENS = "(SELECT NULL::VARCHAR AS mint, NULL::BIGINT AS created_at, NULL::BIGINT AS graduated_at WHERE false)";

/** One row per wallet with at least one trade before `asOfDate`. */
export async function compute(
  asOfDate: string,
  inputs: { trades: string; positions: string; tokens?: string | null },
): Promise<Metrics[]> {
  const asOf = bound(asOfDate);
  const t = tradesAsOf(inputs.trades, asOf);
  const closed = positionsClosedAsOf(inputs.positions, asOf);
  const tokens = inputs.tokens ? tokensKnownAsOf(inputs.tokens, asOf) : NO_TOKENS;
  const order = "PARTITION BY wallet ORDER BY closed_at, mint, position_seq ROWS UNBOUNDED PRECEDING";
  const ratio = (num: string, den: string) => `CASE WHEN (${den}) > 0 THEN (${num}) / (${den}) END`;
  const sql = `
    WITH activity AS (
      SELECT wallet,
             count(DISTINCT mint) AS token_count,
             sum(fee_lamports) AS fees_lamports,
             count(*) AS n_trades,
             count(DISTINCT block_time // 3600) AS active_hours,
             max(block_time) AS last_active_at
      FROM ${t} GROUP BY wallet
    ),
    closed_counts AS (
      SELECT wallet, count(*) AS n_closed, count(*) FILTER (WHERE complete) AS n_complete
      FROM ${closed} GROUP BY wallet
    ),
    complete AS (
      SELECT p.*, k.created_at, k.graduated_at,
             sum(p.realized_pnl_lamports) OVER (${order}) AS cum
      FROM ${closed} p LEFT JOIN ${tokens} k USING (mint)
      WHERE p.complete
    ),
    peaked AS (
      SELECT *, greatest(max(cum) OVER (${order}), 0) AS peak FROM complete
    ),
    perf AS (
      SELECT wallet,
             count(*) AS trade_count,
             sum(realized_pnl_lamports) AS pnl_lamports,
             count(*) FILTER (WHERE realized_pnl_lamports > 0) AS wins,
             max(realized_pnl_lamports) AS best,
             sum(realized_pnl_lamports) FILTER (WHERE realized_pnl_lamports > 0) AS gross_profit,
             median(closed_at - opened_at) AS median_hold_seconds,
             median(opened_at - created_at) AS median_entry_age_seconds,
             count(*) FILTER (WHERE opened_at < graduated_at) AS pre_grad,
             count(created_at) AS known_token,
             max(peak - cum) AS max_drawdown_lamports
      FROM peaked GROUP BY wallet
    )
    SELECT DATE ${lit(asOfDate)} AS as_of_date,
           a.wallet,
           coalesce(p.trade_count, 0) AS trade_count,
           a.token_count,
           coalesce(p.pnl_lamports, 0) / 1e9 AS realized_pnl_sol,
           a.fees_lamports / 1e9 AS fees_sol,
           ${ratio("p.wins", "coalesce(p.trade_count, 0)")} AS win_rate,
           ${ratio("p.best", "p.gross_profit")} AS pnl_concentration,
           p.median_hold_seconds,
           p.median_entry_age_seconds,
           -- Only positions whose token we know; the rest can't be judged.
           ${ratio("p.pre_grad", "p.known_token")} AS pre_graduation_ratio,
           ${ratio("a.n_trades", "a.active_hours")} AS tx_per_active_hour,
           a.last_active_at,
           p.max_drawdown_lamports / 1e9 AS max_drawdown_sol,
           ${ratio("c.n_closed - c.n_complete", "c.n_closed")} AS unknown_cost_ratio
    FROM activity a
    LEFT JOIN closed_counts c USING (wallet)
    LEFT JOIN perf p USING (wallet)
    ORDER BY a.wallet`;
  const rows = await queryRows(sql);
  return rows.map((r) => fromDb<Metrics>(r, SCHEMAS.wallet_metrics_daily));
}
