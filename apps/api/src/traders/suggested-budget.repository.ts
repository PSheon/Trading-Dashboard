import { Inject, Injectable } from "@nestjs/common";
import { CHAIN_DEFAULT } from "@trading-dashboard/shared/contracts";
import { archiveIngestState, traderSuggestedBudgets } from "@trading-dashboard/shared/database";
import { and, eq, inArray, sql } from "drizzle-orm";

import { SUGGESTED_BUDGET_EQUITY_MAX_AGE_MS, SUGGESTED_BUDGET_FILLS_CAP, SUGGESTED_BUDGET_MIN_ADDS, SUGGESTED_BUDGET_RUN_BUDGET_MS, SUGGESTED_BUDGET_WINDOW_MS } from "../config/constants/limits.js";
import { EXCHANGE_MIN_ORDER_NOTIONAL_USD } from "../copy/min-order-notional.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { safeErrorText } from "../runtime/safe-error-text.js";

/** Copies that still follow their leader (as the watcher's copied set). */
const FOLLOWING = ["active", "paused", "stopping"] as const;
/** Fills that increase a position: an open, or the part of a flip past zero. */
const OPEN_DIRS = ["Open Long", "Open Short"] as const;
const FLIP_DIRS = ["Long > Short", "Short > Long"] as const;

type Db = Pick<DrizzleDb, "select" | "execute">;
/** `(a, b, c)` for an `in` list. */
const list = (values: readonly (string | number)[]) => sql`(${sql.join(values.map(v => sql`${v}`), sql`, `)})`;
/** `array['a', 'b']::text[]` (a JS array alone would be expanded into a row). */
const textArray = (values: readonly string[]) => sql`array[${sql.join(values.map(v => sql`${v}`), sql`, `)}]::text[]`;
/** A non-negative integer of our own (an id, a cap) as a literal, so the planner sees the value. */
const literal = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error("suggested_budget_literal"); return sql.raw(String(value)); };

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

export interface SuggestedBudgetRefresh {
  skipped: false;
  /** Leaders written this run. */
  leaders: number;
  /** Of them, with a suggestion (the rest are null: too few adds or no equity). */
  suggested: number;
  /** Of them, read through their newest SUGGESTED_BUDGET_FILLS_CAP fills only. */
  sampled: number;
  /** Leaders whose own statement failed, skipped until the next pass reaches them. */
  failed: { address: string; error: string }[];
  /** Leaders the time budget left to the next tick (0: the pass is complete). */
  remaining: number;
  ms: number;
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
 *
 * One leader a statement (Stage 2026-10-24: a 100-leader statement joining history_fills through history_accounts
 * never finished under the 15 s statement timeout, and the table had no row). The statement reads the leader's
 * fills by a literal `account_id` on the `(account_id, time)` index, newest first, at most SUGGESTED_BUDGET_FILLS_CAP
 * + 1 rows: a leader with more (a market maker: 806,756 fills in 30 days on Stage) gets the median of its newest
 * `cap` fills and a row marked `sampled`. A run reads leaders in address order until SUGGESTED_BUDGET_RUN_BUDGET_MS
 * has passed (at least one), remembers where it stopped and the next hourly tick continues from there; a leader
 * whose statement fails is skipped and reported, the others are written. One refresh runs at a time (an hourly
 * tick that finds the previous one still going is skipped).
 */
@Injectable()
export class SuggestedBudgetRepository {
  private flight: Promise<SuggestedBudgetRefresh> | undefined;
  /** The last leader the previous run wrote before its budget ran out; undefined when its pass was complete. */
  private cursor: string | undefined;
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  find(addresses: readonly string[]) { return suggestedMinBudgets(this.db, addresses); }

  /** Where the window starts: 30 days back, or the retention cut when that is later. */
  async windowFrom(now: Date): Promise<Date> {
    const from = new Date(now.getTime() - SUGGESTED_BUDGET_WINDOW_MS);
    const [state] = await this.db.select({ retainedFrom: archiveIngestState.retainedFrom }).from(archiveIngestState).where(eq(archiveIngestState.chain, CHAIN_DEFAULT));
    return state?.retainedFrom && state.retainedFrom > from ? state.retainedFrom : from;
  }

  /** Every watched, copied or pool leader, lower-cased, once, in address order (the cursor's order). */
  async targets(): Promise<string[]> {
    const chain = CHAIN_DEFAULT;
    const result = await this.db.execute<{ address: string }>(sql`
      select distinct lower(address) as address from (
        select address from leaders where chain = ${chain} and active
        union all select leader_address from copy_strategies where chain = ${chain} and status in ${list(FOLLOWING)}
        union all select address from discovery_traders where chain = ${chain} and in_pool
      ) t order by address`);
    return result.rows.map(row => row.address);
  }

  /**
   * Recomputes the row of every target leader, one leader a statement, for up to `budgetMs`, and drops the rows
   * of leaders that are none of these any more. A refresh already running makes this call return `{ skipped: true }`
   * at once.
   */
  async refresh(now = new Date(), budgetMs = SUGGESTED_BUDGET_RUN_BUDGET_MS): Promise<SuggestedBudgetRefresh | { skipped: true }> {
    if (this.flight) return { skipped: true };
    this.flight = this.run(now, budgetMs).finally(() => { this.flight = undefined; });
    return this.flight;
  }

  private async run(now: Date, budgetMs: number): Promise<SuggestedBudgetRefresh> {
    const started = Date.now();
    const from = await this.windowFrom(now), equityFrom = new Date(now.getTime() - SUGGESTED_BUDGET_EQUITY_MAX_AGE_MS);
    const chain = CHAIN_DEFAULT, targets = await this.targets();
    const cursor = this.cursor, pending = cursor === undefined ? targets : targets.filter(address => address > cursor);
    const accounts = await this.accountIds(pending);
    let leaders = 0, suggested = 0, sampled = 0, done = 0;
    const failed: SuggestedBudgetRefresh["failed"] = [];
    for (; done < pending.length; done++) {
      if (done > 0 && Date.now() - started >= budgetMs) break;
      const address = pending[done]!;
      try {
        const row = await this.leader(address, accounts.get(address), from, now, equityFrom);
        leaders += 1;
        if (row.suggested !== null) suggested += 1;
        if (row.sampled) sampled += 1;
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        failed.push({ address, error: `${typeof code === "string" ? `${code} ` : ""}${safeErrorText(error)}` });
      }
    }
    const remaining = pending.length - done;
    this.cursor = remaining > 0 ? pending[done - 1] : undefined;
    // Rows of leaders that are none of the targets any more (a stale suggestion is worse than none).
    await this.db.execute(sql`delete from trader_suggested_budgets where chain = ${chain} and not (address = any(${textArray(targets)}))`);
    return { skipped: false, leaders, suggested, sampled, failed, remaining, ms: Date.now() - started };
  }

  /** The history account of each address that has one (a leader without is written with no adds). */
  private async accountIds(addresses: readonly string[]): Promise<Map<string, number>> {
    if (!addresses.length) return new Map();
    const result = await this.db.execute<{ id: number; address: string }>(sql`
      select id, address from history_accounts where chain = ${CHAIN_DEFAULT} and address = any(${textArray(addresses)})`);
    return new Map(result.rows.map(row => [row.address, row.id]));
  }

  /** One leader's row, from one statement over its newest fills in the window (at most the cap + 1). */
  private async leader(address: string, accountId: number | undefined, from: Date, now: Date, equityFrom: Date): Promise<{ suggested: number | null; sampled: boolean }> {
    const chain = CHAIN_DEFAULT, cap = SUGGESTED_BUDGET_FILLS_CAP;
    const scope = accountId === undefined ? sql`false` : sql`hf.account_id = ${literal(accountId)}`;
    const result = await this.db.execute<{ suggested: number | null; sampled: boolean }>(sql`
      with newest as (
        select hf.tid, hf.twap, hf.time, hf.coin_id, hf.oid, hf.dir_id, hf.px, hf.sz, hf.start_position
        from history_fills hf
        where ${scope} and hf.time >= ${from} and hf.time < ${now} and hf.px is not null and hf.sz is not null
        order by hf.time desc limit ${literal(cap + 1)}),
      numbered as (select n.*, row_number() over (order by n.time desc, n.tid desc) as rn, count(*) over () as scanned from newest n),
      fills as (
        select distinct on (f.tid) f.coin_id, coalesce(f.oid, f.tid) as order_key,
          case when d.term in ${list(OPEN_DIRS)} then f.px * f.sz
               when d.term in ${list(FLIP_DIRS)} and f.start_position is not null then f.px * greatest(f.sz - abs(f.start_position), 0)
               else 0 end as notional
        from numbered f
        left join history_terms d on d.id = f.dir_id
        where f.rn <= ${literal(cap)}
        order by f.tid, f.twap desc),
      orders as (select sum(notional) as notional from fills group by coin_id, order_key having sum(notional) > 0),
      stats as (select count(*)::int as adds, percentile_cont(0.5) within group (order by notional::double precision) as median from orders),
      equity as (
        select coalesce(
          (select es.account_value from equity_snapshots es where es.chain = ${chain} and es.address = ${address} and es.ts >= ${equityFrom} order by es.ts desc limit 1),
          (select ts.account_value from trader_stats ts where ts.chain = ${chain} and ts.address = ${address} and not ts.is_vault),
          (select dt.account_value from discovery_traders dt where dt.chain = ${chain} and dt.address = ${address})) as value),
      written as (
        insert into trader_suggested_budgets (chain, address, suggested_min_budget_usd, adds, median_add_notional_usd, leader_perp_equity_usd, window_from, computed_at, sampled)
        select ${chain}, ${address},
          case when coalesce(s.adds, 0) >= ${SUGGESTED_BUDGET_MIN_ADDS} and s.median > 0 and e.value > 0
               then least(ceil(${EXCHANGE_MIN_ORDER_NOTIONAL_USD} * e.value::double precision / s.median), 2147483647)::int else null end,
          coalesce(s.adds, 0), s.median, e.value, ${from}, ${now},
          coalesce((select scanned > ${literal(cap)} from numbered limit 1), false)
        from stats s cross join equity e
        on conflict (chain, address) do update set suggested_min_budget_usd = excluded.suggested_min_budget_usd, adds = excluded.adds,
          median_add_notional_usd = excluded.median_add_notional_usd, leader_perp_equity_usd = excluded.leader_perp_equity_usd,
          window_from = excluded.window_from, computed_at = excluded.computed_at, sampled = excluded.sampled
        returning suggested_min_budget_usd as suggested, sampled)
      select suggested, sampled from written`);
    const row = result.rows[0];
    if (!row) throw new Error("suggested_budget_not_written");
    return row;
  }
}
