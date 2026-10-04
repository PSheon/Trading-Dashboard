import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, gte, lt, lte, sql } from "drizzle-orm";
import { copyEquitySnapshots, copyEvents, copyOperations, copyPaperFills, copyStrategies } from "@trading-dashboard/shared/database";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";

/** Only normalized schema-parsed JSON is fingerprinted; object order is irrelevant. */
export function operationFingerprint(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v !== null && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "idempotencyKey").sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)])) : v;
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

@Injectable()
export class CopyRuntimeRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async mutate(tx: DbTransaction, userId: number, operation: string, payload: unknown, key: string | undefined,
    work: () => Promise<{ strategyId: number }>): Promise<{ strategyId: number }> {
    // Paper compatibility: old clients may omit a key; live operations must not use this path.
    if (!key) return work();
    const fingerprint = operationFingerprint(payload);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`copy-operation:${userId}:paper:virtual:${key}`}, 0))`);
    const where = and(eq(copyOperations.userId, userId), eq(copyOperations.mode, "paper"), eq(copyOperations.network, "virtual"), eq(copyOperations.key, key));
    const [old] = await tx.select().from(copyOperations).where(where);
    if (old) {
      if (old.operation !== operation || old.fingerprint !== fingerprint) throw new ConflictException({ statusCode: 409, code: "idempotency_conflict", message: "This operation key was used for a different request" });
      return old.result;
    }
    const result = await work();
    await tx.insert(copyOperations).values({ userId, mode: "paper", network: "virtual", key, operation, fingerprint, result });
    return result;
  }

  async appendEvent(tx: DbTransaction, userId: number, strategyId: number | null, type: string, payload: Record<string, unknown>): Promise<void> {
    const input = structuredClone(payload);
    if (strategyId !== null) await this.requirePaper(tx, strategyId, userId);
    // IDs for the same owner's feed are allocated in commit order. Otherwise
    // polling could pass an id still invisible in an earlier open transaction.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`copy-events:${userId}`}, 0))`);
    await tx.insert(copyEvents).values({ userId, strategyId, type, payload: input });
  }

  events(userId: number, after: bigint, limit: number, before?: bigint) {
    const replay = after > 0n && before === undefined;
    return this.db.select().from(copyEvents).where(and(eq(copyEvents.userId, userId),
      sql`(${copyEvents.strategyId} is null or exists (select 1 from ${copyStrategies} where ${copyStrategies.id} = ${copyEvents.strategyId} and ${copyStrategies.mode} = 'paper'))`,
      before !== undefined ? lt(copyEvents.id, before) : replay ? gt(copyEvents.id, after) : undefined))
      .orderBy(replay ? asc(copyEvents.id) : desc(copyEvents.id)).limit(limit);
  }

  activeStrategies() {
    return this.db.select({ id: copyStrategies.id }).from(copyStrategies)
      .where(and(eq(copyStrategies.mode, "paper"), sql`${copyStrategies.status} <> 'stopped'`)).orderBy(asc(copyStrategies.id));
  }

  async performance(strategyId: number, from: Date, to: Date, baselineTime: Date, bucketMs: number, freshMs: number) {
    const inWindow = and(eq(copyEquitySnapshots.strategyId, strategyId), gte(copyEquitySnapshots.time, from), lte(copyEquitySnapshots.time, to));
    const sampled = await this.db.execute(sql`
      select distinct on (bucket) time, equity, total_pnl, net_deposits, exposure_usd, missing
      from (
        select *, floor(extract(epoch from time) * 1000 / ${bucketMs}) as bucket,
          bool_or(equity is null or extract(epoch from (time - previous)) * 1000 > ${freshMs})
            over (partition by floor(extract(epoch from time) * 1000 / ${bucketMs})) as missing
        from (
          select *, lag(time) over(order by time) as previous from ${copyEquitySnapshots}
          where strategy_id = ${strategyId} and time >= ${from} and time <= ${to}
        ) continuous
      ) observed order by bucket, time desc limit 1001
    `);
    const [first] = await this.db.select().from(copyEquitySnapshots).where(eq(copyEquitySnapshots.strategyId, strategyId)).orderBy(asc(copyEquitySnapshots.time)).limit(1);
    const [last] = await this.db.select().from(copyEquitySnapshots).where(inWindow).orderBy(desc(copyEquitySnapshots.time)).limit(1);
    const [windowFirst] = await this.db.select().from(copyEquitySnapshots).where(inWindow).orderBy(asc(copyEquitySnapshots.time)).limit(1);
    const gap = await this.db.execute(sql`select max(extract(epoch from (time - previous))) * 1000 as gap from (
      select time, lag(time) over(order by time) as previous from ${copyEquitySnapshots}
      where strategy_id = ${strategyId} and time >= ${from} and time <= ${to}
    ) intervals`);
    const [baseline] = await this.db.select().from(copyEquitySnapshots).where(and(eq(copyEquitySnapshots.strategyId, strategyId), lte(copyEquitySnapshots.time, baselineTime)))
      .orderBy(desc(copyEquitySnapshots.time)).limit(1);
    return { sampled: sampled.rows, first, last, windowFirst, maxGap: Number(gap.rows[0]?.gap ?? 0), baseline };
  }

  /** First creation time of the owner's paper copies (the portfolio's "all" start). */
  async firstCopyAt(userId: number): Promise<Date | null> {
    const [row] = await this.db.select({ at: sql<Date | string | null>`min(${copyStrategies.createdAt})` }).from(copyStrategies)
      .where(and(eq(copyStrategies.userId, userId), eq(copyStrategies.mode, "paper")));
    return row?.at ? new Date(row.at) : null;
  }

  /**
   * The owner's whole paper portfolio at each time of `from…to` (every
   * `stepMs`, `to` included): the sum of each copy's latest PnL at or before
   * that time. A copy not yet started adds 0; a copy younger than `freshMs`
   * without a valuation yet adds 0 (PnL is 0 at its start); a stopped copy
   * adds its final PnL; any other copy without a valuation of the last
   * `freshMs` (or with an unpriced one) makes the time `missing`.
   */
  async portfolioSeries(userId: number, from: Date, to: Date, stepMs: number, freshMs: number) {
    const result = await this.db.execute(sql`
      with s as (
        select id, created_at, stopped_at from ${copyStrategies}
        where user_id = ${userId} and mode = 'paper' and created_at <= ${to}
      ), t as (
        select g as time from generate_series(${from}::timestamptz, ${to}::timestamptz, make_interval(secs => ${stepMs / 1000}::double precision)) g
        union select ${to}::timestamptz
      )
      select t.time,
        coalesce(sum(case when s.created_at <= t.time then coalesce(snap.total_pnl, 0) end), 0)::text as pnl,
        coalesce(bool_or(s.created_at <= t.time and not (
          (snap.time is null and extract(epoch from (t.time - s.created_at)) * 1000 <= ${freshMs})
          or (snap.time is not null and snap.total_pnl is not null and ((s.stopped_at is not null and s.stopped_at <= t.time)
            or extract(epoch from (t.time - snap.time)) * 1000 <= ${freshMs}))
        )), false) as missing
      from t left join s on s.created_at <= t.time
      left join lateral (
        select e.time, e.total_pnl from ${copyEquitySnapshots} e
        where e.strategy_id = s.id and e.time <= t.time order by e.time desc limit 1
      ) snap on true
      group by t.time order by t.time
    `);
    return result.rows.map((r) => ({ time: new Date(r.time as string | Date), pnl: String(r.pnl), missing: Boolean(r.missing) }));
  }

  /** Each copy's PnL at `points` evenly spaced times from its start to its
   * stop (or now); null where it had no fresh valuation. */
  async sparklines(userId: number, points: number, freshMs: number) {
    const last = points - 1;
    const result = await this.db.execute(sql`
      select s.id as strategy_id, g.i,
        case
          when snap.time is null then case when g.i = 0 then '0' else null end
          when snap.total_pnl is null then null
          when s.stopped_at is not null and s.stopped_at <= tt.time then snap.total_pnl::text
          when extract(epoch from (tt.time - snap.time)) * 1000 > ${freshMs} then null
          else snap.total_pnl::text
        end as pnl
      from ${copyStrategies} s
      cross join generate_series(0, ${last}::int) g(i)
      cross join lateral (select s.created_at + (coalesce(s.stopped_at, now()) - s.created_at) * (g.i::double precision / ${last}::double precision) as time) tt
      left join lateral (
        select e.time, e.total_pnl from ${copyEquitySnapshots} e
        where e.strategy_id = s.id and e.time <= tt.time order by e.time desc limit 1
      ) snap on true
      where s.user_id = ${userId} and s.mode = 'paper'
      order by s.id, g.i
    `);
    const out = new Map<number, (string | null)[]>();
    for (const r of result.rows) {
      const id = Number(r.strategy_id);
      const list = out.get(id) ?? [];
      list.push(r.pnl === null ? null : String(r.pnl));
      out.set(id, list);
    }
    return out;
  }

  /** Per copy still running at `dayStart` or started since: its latest
   * valuation at or before `dayStart` and its latest valuation. */
  async todayInputs(userId: number, dayStart: Date) {
    const result = await this.db.execute(sql`
      select s.id, s.created_at, s.stopped_at, b.time as base_time, b.total_pnl::text as base_pnl, l.time as last_time, l.total_pnl::text as last_pnl
      from ${copyStrategies} s
      left join lateral (select time, total_pnl from ${copyEquitySnapshots} e where e.strategy_id = s.id and e.time <= ${dayStart} order by e.time desc limit 1) b on true
      left join lateral (select time, total_pnl from ${copyEquitySnapshots} e where e.strategy_id = s.id order by e.time desc limit 1) l on true
      where s.user_id = ${userId} and s.mode = 'paper' and (s.stopped_at is null or s.stopped_at >= ${dayStart})
    `);
    const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string | Date));
    return result.rows.map((r) => ({
      id: Number(r.id), createdAt: new Date(r.created_at as string | Date), stoppedAt: date(r.stopped_at),
      baseTime: date(r.base_time), basePnl: (r.base_pnl as string | null) ?? null, lastTime: date(r.last_time), lastPnl: (r.last_pnl as string | null) ?? null,
    }));
  }

  /**
   * The owner's closed copy trades, rebuilt from the copies' fills. A trade
   * starts at a fill made from a flat position and ends when the position is
   * back at 0; the engine splits a flip into a close and an open, so a fill
   * never crosses 0. Amounts stay exact numerics until the caller.
   */
  async closedTrades(userId: number, sort: "best" | "worst" | "recent", limit: number, strategyId?: number) {
    const order = sort === "best" ? sql`net desc, closed_at desc` : sort === "worst" ? sql`net asc, closed_at desc` : sql`closed_at desc, open_id desc`;
    const filter = sort === "best" ? sql`and net > 0` : sort === "worst" ? sql`and net < 0` : sql``;
    const result = await this.db.execute(sql`
      with f as (
        select f.id, f.strategy_id, f.coin, f.size, f.px, f.fee + f.builder_fee as fees, f.realized_pnl, f.ts,
          case when f.side = 'B' then f.size else -f.size end as signed
        from ${copyPaperFills} f join ${copyStrategies} s on s.id = f.strategy_id
        where s.user_id = ${userId} and s.mode = 'paper' ${strategyId === undefined ? sql`` : sql`and s.id = ${strategyId}`}
      ), r as (
        select *, sum(signed) over (partition by strategy_id, coin order by ts, id) as after from f
      ), g as (
        select *, after - signed as before,
          sum(case when after - signed = 0 then 1 else 0 end) over (partition by strategy_id, coin order by ts, id) as trade_no
        from r
      ), t as (
        select strategy_id, coin, trade_no,
          (array_agg(id order by ts, id))[1] as open_id,
          (array_agg(signed order by ts, id))[1] as first_signed,
          sum(case when abs(after) > abs(before) then size * px end) as entry_notional,
          sum(case when abs(after) > abs(before) then size end) as entry_size,
          sum(case when abs(after) < abs(before) then size * px end) as exit_notional,
          sum(case when abs(after) < abs(before) then size end) as exit_size,
          sum(realized_pnl) - sum(fees) as net, sum(fees) as fees, min(ts) as opened_at, max(ts) as closed_at,
          (array_agg(after order by ts desc, id desc))[1] as final
        from g group by strategy_id, coin, trade_no
      )
      select t.open_id::text, t.strategy_id, s.leader_address, t.coin, t.first_signed::text, t.entry_notional::text, t.entry_size::text,
        t.exit_notional::text, t.exit_size::text, t.net::text, t.fees::text, t.opened_at, t.closed_at
      from t join ${copyStrategies} s on s.id = t.strategy_id
      where t.final = 0 and t.entry_size > 0 and t.exit_size > 0 ${filter}
      order by ${order} limit ${limit}
    `);
    return result.rows.map((r) => ({
      openId: String(r.open_id), strategyId: Number(r.strategy_id), leaderAddress: String(r.leader_address), coin: String(r.coin),
      firstSigned: String(r.first_signed), entryNotional: String(r.entry_notional), entrySize: String(r.entry_size),
      exitNotional: String(r.exit_notional), exitSize: String(r.exit_size), net: String(r.net), fees: String(r.fees),
      openedAt: new Date(r.opened_at as string | Date), closedAt: new Date(r.closed_at as string | Date),
    }));
  }

  async snapshot(tx: DbTransaction, row: typeof copyEquitySnapshots.$inferInsert): Promise<void> {
    const input = structuredClone(row);
    await this.requirePaper(tx, input.strategyId);
    await tx.insert(copyEquitySnapshots).values(input).onConflictDoNothing();
  }

  private async requirePaper(tx: DbTransaction, strategyId: number, userId?: number): Promise<void> {
    const [row] = await tx.select({ id: copyStrategies.id }).from(copyStrategies).where(and(eq(copyStrategies.id, strategyId), eq(copyStrategies.mode, "paper"),
      userId === undefined ? undefined : eq(copyStrategies.userId, userId))).for("share");
    if (!row) throw new Error("paper_strategy_required");
  }
}
