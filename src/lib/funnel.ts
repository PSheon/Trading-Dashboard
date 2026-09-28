// The discovery funnel: from tokens that did well, back to the wallets that
// were early and made money on several of them. One Dune query per run.
//
//   1. pump.fun tokens that graduated inside the lookback window: the first
//      PumpSwap trade comes within MIGRATION_SECONDS of the last curve trade
//      (a pool opened later by hand on an abandoned curve is not a graduation).
//      Curve trades are read CURVE_EXTRA_DAYS further back so a creation is not
//      cut off by the window.
//   2. keep those whose peak market cap after graduation reaches minPeakMcapSol.
//      Peak = the highest hourly volume-weighted price over hours with at least
//      minHourVolumeSol traded by at least MIN_HOUR_TRADERS wallets, × 1B supply;
//      a thin fill or a drained pool cannot set it. Curves bought out within
//      MIN_CURVE_SECONDS of creation (bundled launches) are left out.
//   3. per token, wallets whose first buy came before graduation, not in the
//      token's first slot (the dev buy and bundles land there), and who took
//      out more SOL than they put in
//   4. keep wallets doing that on at least minWins tokens, drop the ones too
//      busy to be anything but bots, rank by SOL taken out, take maxWallets
//
// Selecting on outcomes is fine for finding candidates; evaluation stays
// honest because a wallet only enters backtests from first_seen_at on
// (principle 5). The run records its parameters, its tokens and its ranked
// wallets, so any wallet can be traced back to why it was picked.

import { WSOL_MINT } from "./constants";
import { lit } from "./db";
import type { DuneClient } from "./dune";
import type { Warehouse } from "./store";
import { addWallets } from "./wallets";

export interface FunnelParams {
  lookbackDays: number;
  minPeakMcapSol: number;
  minWins: number;
  maxWallets: number;
  maxTradesPerDay: number; // busier than this on pump venues is treated as a bot
  minHourVolumeSol: number; // hours thinner than this do not set the peak price
}

export const MIGRATION_SECONDS = 600;
export const CURVE_EXTRA_DAYS = 30;
export const MIN_CURVE_SECONDS = 60;
export const MIN_HOUR_TRADERS = 5;

export const DEFAULT_FUNNEL: FunnelParams = {
  lookbackDays: 14,
  minPeakMcapSol: 2_000,
  minWins: 3,
  maxWallets: 50,
  maxTradesPerDay: 50,
  minHourVolumeSol: 10,
};

export function funnelSql(p: FunnelParams): string {
  const since = `now() - interval '${Math.floor(p.lookbackDays)}' day`;
  const curveSince = `now() - interval '${Math.floor(p.lookbackDays) + CURVE_EXTRA_DAYS}' day`;
  const wsol = lit(WSOL_MINT);
  return `
WITH curve_trades AS (
  SELECT block_time, block_slot,
         CASE WHEN token_bought_mint_address = ${wsol} THEN token_sold_mint_address ELSE token_bought_mint_address END AS mint
  FROM dex_solana.trades
  WHERE block_time >= ${curveSince} AND project = 'pumpdotfun'
    AND (token_bought_mint_address = ${wsol} OR token_sold_mint_address = ${wsol})
),
pump AS (
  SELECT block_time, block_slot, trader_id, project,
         CASE WHEN token_bought_mint_address = ${wsol} THEN token_sold_mint_address ELSE token_bought_mint_address END AS mint,
         CASE WHEN token_bought_mint_address = ${wsol} THEN 'sell' ELSE 'buy' END AS side,
         CASE WHEN token_bought_mint_address = ${wsol} THEN token_bought_amount ELSE token_sold_amount END AS sol,
         -- Raw units over 10^6: every pump.fun token has 6 decimals, and Dune's
         -- decimal-adjusted amount is wrong for some (off by 1000 in P1 testing).
         CASE WHEN token_bought_mint_address = ${wsol} THEN CAST(token_sold_amount_raw AS double)
              ELSE CAST(token_bought_amount_raw AS double) END / 1e6 AS tokens
  FROM dex_solana.trades
  WHERE block_time >= ${since}
    AND project IN ('pumpdotfun', 'pumpswap')
    AND (token_bought_mint_address = ${wsol} OR token_sold_mint_address = ${wsol})
),
activity AS (SELECT trader_id, count(*) AS n FROM pump GROUP BY trader_id),
curve AS (
  SELECT mint, min(block_time) AS created, max(block_time) AS last_curve, min(block_slot) AS first_slot
  FROM curve_trades GROUP BY mint
  -- a creation within a day of the extended start may be the window cutting it off
  HAVING min(block_time) > ${curveSince} + interval '1' day
),
grad AS (
  SELECT c.mint, c.created, c.first_slot, min(p.block_time) AS graduated
  FROM curve c
  JOIN pump p ON p.mint = c.mint AND p.project = 'pumpswap' AND p.block_time >= c.last_curve
  GROUP BY c.mint, c.created, c.first_slot, c.last_curve
  HAVING min(p.block_time) <= c.last_curve + interval '${MIGRATION_SECONDS}' second
     -- a curve bought out within a minute of creation is a bundled launch: nobody
     -- could be early on it, and its pool is usually drained right after
     AND min(p.block_time) > c.created + interval '${MIN_CURVE_SECONDS}' second
),
hourly AS (
  SELECT g.mint, date_trunc('hour', p.block_time) AS hour, sum(p.sol) / sum(p.tokens) AS vwap
  FROM grad g
  JOIN pump p ON p.mint = g.mint AND p.project = 'pumpswap' AND p.block_time >= g.graduated AND p.tokens > 0
  GROUP BY g.mint, date_trunc('hour', p.block_time)
  -- a drained pool trades at absurd prices among a handful of wallets
  HAVING sum(p.sol) >= ${p.minHourVolumeSol} AND count(DISTINCT p.trader_id) >= ${MIN_HOUR_TRADERS}
),
peak AS (
  SELECT g.mint, g.created, g.graduated, g.first_slot,
         max(h.vwap) * 1e9 AS peak_mcap_sol,
         max_by(h.hour, h.vwap) AS peak_at
  FROM grad g JOIN hourly h ON h.mint = g.mint
  GROUP BY g.mint, g.created, g.graduated, g.first_slot
),
winners AS (SELECT * FROM peak WHERE peak_mcap_sol >= ${p.minPeakMcapSol}),
flows AS (
  SELECT w.mint, p.trader_id,
         min(p.block_time) FILTER (WHERE p.side = 'buy') AS first_buy,
         min(p.block_slot) FILTER (WHERE p.side = 'buy') AS first_buy_slot,
         coalesce(sum(p.sol) FILTER (WHERE p.side = 'buy'), 0) AS sol_in,
         coalesce(sum(p.sol) FILTER (WHERE p.side = 'sell'), 0) AS sol_out
  FROM winners w JOIN pump p ON p.mint = w.mint
  GROUP BY w.mint, p.trader_id
),
early AS (
  SELECT f.* FROM flows f JOIN winners w ON w.mint = f.mint
  WHERE f.first_buy < w.graduated AND f.first_buy_slot > w.first_slot AND f.sol_out > f.sol_in
),
ranked AS (
  SELECT e.trader_id AS wallet, count(DISTINCT e.mint) AS wins, sum(e.sol_out - e.sol_in) AS pnl_sol,
         min_by(e.mint, e.first_buy) AS first_token, max(a.n) AS pump_trades
  FROM early e JOIN activity a ON a.trader_id = e.trader_id
  WHERE a.n <= ${Math.floor(p.maxTradesPerDay * p.lookbackDays)}
  GROUP BY e.trader_id
  HAVING count(DISTINCT e.mint) >= ${Math.floor(p.minWins)}
)
SELECT 'stats' AS kind, CAST(NULL AS varchar) AS mint, CAST(NULL AS varchar) AS wallet,
       CAST(NULL AS double) AS created_at, CAST(NULL AS double) AS graduated_at, CAST(NULL AS double) AS peak_at,
       (SELECT count(*) FROM grad) AS count_a, (SELECT count(*) FROM winners) AS count_b,
       (SELECT approx_percentile(peak_mcap_sol, 0.5) FROM peak) AS value_a,
       (SELECT approx_percentile(peak_mcap_sol, 0.9) FROM peak) AS value_b,
       CAST(NULL AS varchar) AS first_token
UNION ALL
SELECT 'token', mint, NULL, to_unixtime(created), to_unixtime(graduated), to_unixtime(peak_at),
       NULL, NULL, peak_mcap_sol, NULL, NULL
FROM winners
UNION ALL
SELECT 'wallet', NULL, wallet, NULL, NULL, NULL, wins, pump_trades, pnl_sol, NULL, first_token
FROM (SELECT * FROM ranked ORDER BY pnl_sol DESC, wins DESC, wallet LIMIT ${Math.floor(p.maxWallets)})`;
}

export interface FunnelResult {
  stats: { graduated: number; winners: number; peak_p50_sol: number | null; peak_p90_sol: number | null };
  tokens: { mint: string; created_at: number; graduated_at: number; peak_at: number; peak_mcap_sol: number }[];
  wallets: { wallet: string; wins: number; pump_trades: number; pnl_sol: number; first_token: string; rank: number }[];
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function parseFunnel(rows: readonly Record<string, unknown>[]): FunnelResult {
  const stats = rows.find((r) => r.kind === "stats");
  return {
    stats: {
      graduated: n(stats?.count_a) ?? 0,
      winners: n(stats?.count_b) ?? 0,
      peak_p50_sol: n(stats?.value_a),
      peak_p90_sol: n(stats?.value_b),
    },
    tokens: rows
      .filter((r) => r.kind === "token")
      .map((r) => ({
        mint: String(r.mint),
        created_at: Math.floor(n(r.created_at)!),
        graduated_at: Math.floor(n(r.graduated_at)!),
        peak_at: Math.floor(n(r.peak_at)!),
        peak_mcap_sol: n(r.value_a)!,
      }))
      .sort((a, b) => b.peak_mcap_sol - a.peak_mcap_sol),
    wallets: rows
      .filter((r) => r.kind === "wallet")
      .map((r) => ({
        wallet: String(r.wallet),
        wins: n(r.count_a)!,
        pump_trades: n(r.count_b)!,
        pnl_sol: n(r.value_a)!,
        first_token: String(r.first_token),
      }))
      .sort((a, b) => b.pnl_sol - a.pnl_sol || b.wins - a.wins || (a.wallet < b.wallet ? -1 : 1))
      .map((w, i) => ({ ...w, rank: i + 1 })),
  };
}

export function runId(now: number): string {
  return `funnel-${new Date(now * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
}

/**
 * Run the funnel. With `dryRun`, only report; otherwise record the run and
 * register its wallets (known ones keep their original discovery).
 */
export async function runFunnel(
  wh: Warehouse,
  dune: DuneClient,
  opts: { now: number; params?: Partial<FunnelParams>; dryRun?: boolean },
) {
  const params = { ...DEFAULT_FUNNEL, ...opts.params };
  const { executionId, rows } = await dune.run(funnelSql(params), "medium");
  const result = parseFunnel(rows);
  const id = runId(opts.now);
  if (opts.dryRun) return { run_id: null, execution_id: executionId, params, ...result, added: [] as string[] };

  await wh.locked(async () => {
    await wh.write("funnel_runs", [
      ...(await wh.read("funnel_runs")),
      {
        run_id: id,
        run_at: opts.now,
        execution_id: executionId,
        params: JSON.stringify(params),
        graduated: result.stats.graduated,
        winners: result.stats.winners,
        wallets: result.wallets.length,
      },
    ]);
    await wh.write("funnel_tokens", [
      ...(await wh.read("funnel_tokens")),
      ...result.tokens.map((t) => ({ run_id: id, ...t })),
    ]);
    await wh.write("funnel_wallets", [
      ...(await wh.read("funnel_wallets")),
      ...result.wallets.map((w) => ({ run_id: id, ...w })),
    ]);
  });
  const added: string[] = [];
  for (const w of result.wallets) {
    added.push(
      ...(await addWallets(wh, [w.wallet], { via: "token_funnel", now: opts.now, fromToken: w.first_token, funnelRunId: id })),
    );
  }
  return { run_id: id, execution_id: executionId, params, ...result, added };
}
