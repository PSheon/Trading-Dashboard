import { Inject, Injectable } from "@nestjs/common";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";
import { archiveIngestState, traderSuggestedBudgets } from "@trading-dashboard/shared/database";
import { and, eq, inArray, sql } from "drizzle-orm";

import { SUGGESTED_BUDGET_EQUITY_MAX_AGE_MS, SUGGESTED_BUDGET_MIN_ADDS, SUGGESTED_BUDGET_WINDOW_MS } from "../config/constants/limits.js";
import { EXCHANGE_MIN_ORDER_NOTIONAL_USD } from "../copy/min-order-notional.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

/** Copies that still follow their leader (as the watcher's copied set). */
const FOLLOWING = ["active", "paused", "stopping"] as const;
/** Fills that increase a position: an open, or the part of a flip past zero. */
const OPEN_DIRS = ["Open Long", "Open Short"] as const;
const FLIP_DIRS = ["Long > Short", "Short > Long"] as const;

type Db = Pick<DrizzleDb, "select" | "execute">;
/** `(a, b, c)` for an `in` list. */
const list = (values: readonly (string | number)[]) => sql`(${sql.join(values.map(v => sql`${v}`), sql`, `)})`;

/** The stored suggestion of each address (lower-cased), null when none or not computed. */
export async function suggestedMinBudgets(db: Db, addresses: readonly string[]): Promise<Map<string, number | null>> {
  const wanted = [...new Set(addresses.map(a => a.toLowerCase()))];
  const out = new Map<string, number | null>(wanted.map(a => [a, null]));
  if (!wanted.length) return out;
  const rows = await db.select({ address: traderSuggestedBudgets.address, suggested: traderSuggestedBudgets.suggestedMinBudgetUsd }).from(traderSuggestedBudgets)
    .where(and(eq(traderSuggestedBudgets.chain, CHAIN_DEFAULT), inArray(traderSuggestedBudgets.address, wanted)));
  for (const row of rows) out.set(row.address, row.suggested);
  return out;
}

/**
 * Every leader's suggested minimum budget (decision D7, 2026-10-23):
 *
 *   suggested = ceil(EXCHANGE_MIN_ORDER_NOTIONAL_USD × leader perp equity ÷ median(notional of the leader's
 *               position-increasing orders in the last SUGGESTED_BUDGET_WINDOW_MS))
 *
 * the budget at which the leader's median add, scaled by budget ÷ equity, just reaches the exchange minimum.
 * Recomputed hourly by the read worker (TradersWorker) from what the database already holds: `history_fills`
 * (one row per tid; an order's fills summed by oid; opens count whole, a flip counts the part past zero) and
 * the leader's equity (the latest equity snapshot within a day, else the leaderboard's account value of a
 * non-vault, else the pool's). Fewer than SUGGESTED_BUDGET_MIN_ADDS adds, or no equity: null (no pill).
 * The window never reaches below the history retention cut (`archive_ingest_state.retained_from`).
 */
@Injectable()
export class SuggestedBudgetRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  find(addresses: readonly string[]) { return suggestedMinBudgets(this.db, addresses); }

  /** Where the window starts: 30 days back, or the retention cut when that is later. */
  async windowFrom(now: Date): Promise<Date> {
    const from = new Date(now.getTime() - SUGGESTED_BUDGET_WINDOW_MS);
    const [state] = await this.db.select({ retainedFrom: archiveIngestState.retainedFrom }).from(archiveIngestState).where(eq(archiveIngestState.chain, CHAIN_DEFAULT));
    return state?.retainedFrom && state.retainedFrom > from ? state.retainedFrom : from;
  }

  /** Recomputes the row of every watched, copied or pool leader and drops the rows of leaders that are none of these. */
  async refresh(now = new Date()): Promise<{ leaders: number; suggested: number }> {
    const from = await this.windowFrom(now), equityFrom = new Date(now.getTime() - SUGGESTED_BUDGET_EQUITY_MAX_AGE_MS);
    const chain = CHAIN_DEFAULT;
    const targets = sql`
      select distinct lower(address) as address from (
        select address from leaders where chain = ${chain} and active
        union all select leader_address from copy_strategies where chain = ${chain} and status in ${list(FOLLOWING)}
        union all select address from discovery_traders where chain = ${chain} and in_pool
      ) t`;
    const result = await this.db.execute<{ suggested: number | null }>(sql`
      with targets as (${targets}),
      fills as (
        select distinct on (hf.account_id, hf.tid) ha.address, hf.coin_id, coalesce(hf.oid, hf.tid) as order_key,
          case when d.term in ${list(OPEN_DIRS)} then hf.px * hf.sz
               when d.term in ${list(FLIP_DIRS)} and hf.start_position is not null then hf.px * greatest(hf.sz - abs(hf.start_position), 0)
               else 0 end as notional
        from history_fills hf
        join history_accounts ha on ha.id = hf.account_id and ha.chain = ${chain}
        join targets t on t.address = ha.address
        left join history_terms d on d.id = hf.dir_id
        where hf.time >= ${from} and hf.time < ${now} and hf.px is not null and hf.sz is not null
        order by hf.account_id, hf.tid, hf.twap desc),
      orders as (select address, sum(notional) as notional from fills group by address, coin_id, order_key having sum(notional) > 0),
      stats as (select address, count(*)::int as adds, percentile_cont(0.5) within group (order by notional::double precision) as median from orders group by address),
      equity as (
        select t.address, coalesce(
          (select es.account_value from equity_snapshots es where es.chain = ${chain} and es.address = t.address and es.ts >= ${equityFrom} order by es.ts desc limit 1),
          (select ts.account_value from trader_stats ts where ts.chain = ${chain} and ts.address = t.address and not ts.is_vault),
          (select dt.account_value from discovery_traders dt where dt.chain = ${chain} and dt.address = t.address)) as value
        from targets t),
      written as (
        insert into trader_suggested_budgets (chain, address, suggested_min_budget_usd, adds, median_add_notional_usd, leader_perp_equity_usd, window_from, computed_at)
        select ${chain}, t.address,
          case when coalesce(s.adds, 0) >= ${SUGGESTED_BUDGET_MIN_ADDS} and s.median > 0 and e.value > 0
               then least(ceil(${EXCHANGE_MIN_ORDER_NOTIONAL_USD} * e.value::double precision / s.median), 2147483647)::int else null end,
          coalesce(s.adds, 0), s.median, e.value, ${from}, ${now}
        from targets t left join stats s on s.address = t.address left join equity e on e.address = t.address
        on conflict (chain, address) do update set suggested_min_budget_usd = excluded.suggested_min_budget_usd, adds = excluded.adds,
          median_add_notional_usd = excluded.median_add_notional_usd, leader_perp_equity_usd = excluded.leader_perp_equity_usd,
          window_from = excluded.window_from, computed_at = excluded.computed_at
        returning suggested_min_budget_usd as suggested)
      select suggested from written`);
    await this.db.execute(sql`delete from trader_suggested_budgets where chain = ${chain} and address not in (select address from (${targets}) t)`);
    const rows = result.rows;
    return { leaders: rows.length, suggested: rows.filter(row => row.suggested !== null).length };
  }
}
