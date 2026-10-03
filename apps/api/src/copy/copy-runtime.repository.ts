import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, gte, lt, lte, sql } from "drizzle-orm";
import { copyEquitySnapshots, copyEvents, copyOperations, copyStrategies } from "@trading-dashboard/shared/database";
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
