import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  actions, alerts, copyEvents, copyStrategies, notificationOutbox, notificationChannels, userFavorites, appSettings, users,
} from "@trading-dashboard/shared/database";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import { insertOwnerEvent } from "../copy/copy-runtime.repository.js";
import { COPY_NOTIFICATION_TYPES } from "./copy-message.js";
import { liveCopyPayload, SILENT_LIVE_REFUSALS, type LiveCopySource } from "./live-copy-events.js";
import type { AlertContext } from "./notify.types.js";

export type DeliveryRow = typeof notificationOutbox.$inferSelect;
/** Deliveries read per pass of a drain. */
export const DELIVERY_BATCH = 100;

/** Durable delivery persistence; services own authorization, retry policy and transactions. */
@Injectable()
export class NotifyRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** Owner events to queue for the trade bot: opted in (and only events
   * since), linked and enabled chat, at most `maxAgeMs` old (the trade alerts'
   * cut-off: a fill message is about now), with the owner's language and the
   * copied trader. */
  copyCandidates(maxAgeMs: number) {
    return this.db.select({ event: copyEvents, chatId: notificationChannels.target, locale: users.locale, leaderAddress: copyStrategies.leaderAddress }).from(copyEvents)
      .innerJoin(users, and(eq(users.id, copyEvents.userId), isNull(users.disabledAt)))
      .innerJoin(notificationChannels, and(eq(notificationChannels.userId, copyEvents.userId), eq(notificationChannels.kind, "telegram")))
      .leftJoin(copyStrategies, eq(copyStrategies.id, copyEvents.strategyId))
      .where(and(isNull(copyEvents.notificationQueuedAt), eq(notificationChannels.enabled, true), eq(notificationChannels.copyAlertsEnabled, true),
        gte(copyEvents.createdAt, notificationChannels.copyAlertsSince), sql`${copyEvents.createdAt} >= now() - make_interval(secs => ${maxAgeMs / 1000})`,
        inArray(copyEvents.type, [...COPY_NOTIFICATION_TYPES]),
        // Paper, or an actual copy's event projected from its live rows (never one merely labelled live).
        sql`(${copyEvents.payload}->>'mode' = 'paper' or (${copyEvents.payload}->>'mode' in ('testnet', 'live')
          and jsonb_typeof(${copyEvents.payload}->'liveSource') = 'string' and ${copyStrategies.mode} = 'testnet'))`))
      .orderBy(copyEvents.id).limit(DELIVERY_BATCH);
  }

  /**
   * Actual copies write no owner events: their activity is the live rows.
   * Each terminal one the trade bot sends — a settled leg that filled
   * (`order_filled`, from its order's own fills), a refused leg
   * (`order_rejected`, but not SILENT_LIVE_REFUSALS), a finished stop
   * (`strategy_stopped`) and a credited return to the main wallet
   * (`funds_returned` for a stop's sweep or an aborted setup's refund,
   * else `funds_withdrawn`) — becomes one owner event keyed by
   * `payload.liveSource`, which copyCandidates then queues like a paper one.
   * Only for owners with copy alerts on, rows since the opt-in and at most
   * `maxAgeMs` old (as copyCandidates): never a backfill of history. One
   * projector at a time (transaction lock), so a row is never projected twice.
   */
  async projectLiveCopyEvents(maxAgeMs: number): Promise<number> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('copy-live-notify', 0))`);
      const recent = (at: SQL) => sql`${at} >= o.since and ${at} >= now() - make_interval(secs => ${maxAgeMs / 1000})`;
      const num = (field: string) => sql`(case when r.record->>${field} ~ '^-?[0-9]+(\.[0-9]+)?$' then (r.record->>${field})::numeric end)`;
      const { rows } = await tx.execute<LiveCopySource>(sql`
        with o as (
          select c.user_id, c.copy_alerts_since as since from notification_channels c join users u on u.id = c.user_id and u.disabled_at is null
          where c.kind = 'telegram' and c.enabled and c.copy_alerts_enabled and c.copy_alerts_since is not null
        ), x as (
          select 'dispatch:' || d.id as source, d.user_id, d.strategy_id, s.network, d.settled_at as at, 'order_filled' as type, d.coin, null::text as reason, null::text as amount,
            f.size::text as size, round(f.notional / f.size, 10)::text as px, f.side, f.sides, f.pnl::text as pnl, f.fee::text as fee, f.start
          from copy_live_dispatches d join o on o.user_id = d.user_id join copy_strategies s on s.id = d.strategy_id and s.user_id = d.user_id and s.mode = 'testnet'
          cross join lateral (select sum(${num("size")}) as size, sum(${num("size")} * ${num("price")}) as notional, min(r.record->>'side') as side,
              count(distinct r.record->>'side')::int as sides, sum(${num("closedPnl")}) as pnl, sum(${num("totalFee")}) as fee,
              (array_agg(r.record->'raw'->>'startPosition' order by r.provider_time, r.key))[1] as start,
              count(*) filter (where ${num("size")} is null or ${num("price")} is null) as invalid
            from copy_follower_receipts r where r.execution_key = d.execution_key and r.kind = 'fill' and r.attribution = 'execution') f
          where d.state = 'settled' and ${recent(sql`d.settled_at`)} and f.size > 0 and f.invalid = 0
          union all
          select 'dispatch:' || d.id, d.user_id, d.strategy_id, s.network, d.updated_at,
            -- Hyperliquid liquidated the copy (CP-EXE-16): said as the liquidation, not as an order lost.
            case when d.reason = 'position_liquidated' then 'position_liquidated' else 'order_rejected' end, d.coin, d.reason, null, null, null, null, null, null, null, null
          from copy_live_dispatches d join o on o.user_id = d.user_id join copy_strategies s on s.id = d.strategy_id and s.user_id = d.user_id and s.mode = 'testnet'
          where d.state = 'refused' and d.reason is not null and d.reason not in (${sql.join(SILENT_LIVE_REFUSALS.map(reason => sql`${reason}`), sql`, `)}) and ${recent(sql`d.updated_at`)}
          union all
          select 'stop:' || t.id, t.user_id, t.strategy_id, t.network, t.updated_at, 'strategy_stopped', null, null, null, null, null, null, null, null, null, null
          from copy_live_stop_operations t join o on o.user_id = t.user_id join copy_strategies s on s.id = t.strategy_id and s.user_id = t.user_id and s.mode = 'testnet'
          where t.state = 'stopped' and ${recent(sql`t.updated_at`)}
          union all
          select 'funding:' || fo.id, fo.user_id, fo.strategy_id, fo.network, fo.updated_at,
            case when fo.stop_id is not null or fo.setup_abort_id is not null then 'funds_returned' else 'funds_withdrawn' end, null, null, fo.credited_amount, null, null, null, null, null, null, null
          from copy_funding_operations fo join o on o.user_id = fo.user_id join copy_strategies s on s.id = fo.strategy_id and s.user_id = fo.user_id and s.mode = 'testnet'
          where fo.direction = 'to_main' and fo.status = 'credited' and ${recent(sql`fo.updated_at`)}
        )
        select source, user_id as "userId", strategy_id as "strategyId", network, at, type, coin, reason, amount, size, px, side, sides, pnl, fee, start from x
        -- Projected ones were written after their row's time (an hour covers clock skew).
        where not exists (select 1 from copy_events e where e.user_id = x.user_id and e.created_at >= x.at - interval '1 hour' and e.payload->>'liveSource' = x.source)
        order by x.at, x.source limit ${DELIVERY_BATCH}`);
      for (const row of rows) await insertOwnerEvent(tx, row.userId, row.strategyId, row.type, liveCopyPayload(row));
      return rows.length;
    });
  }

  async enqueueCopy(eventId: bigint, userId: number, payloadJson: Record<string, unknown>, tx: DbTransaction): Promise<void> {
    const claimed = await tx.update(copyEvents).set({ notificationQueuedAt: sql`now()` })
      .where(and(eq(copyEvents.id, eventId), eq(copyEvents.userId, userId), isNull(copyEvents.notificationQueuedAt))).returning({ id: copyEvents.id });
    if (claimed.length) await tx.insert(notificationOutbox).values({ copyEventId: eventId, userId, payloadJson }).onConflictDoNothing();
  }

  async copyEvent(id: bigint, userId: number) {
    const [event] = await this.db.select().from(copyEvents).where(and(eq(copyEvents.id, id), eq(copyEvents.userId, userId)));
    return event;
  }

  /** Insert intent and pending alert rows in the caller's cooldown transaction.
   * A duplicate action/recipient inserts neither another intent nor another log. */
  async enqueue(ctx: AlertContext, payloadJson: Record<string, unknown>, tx: DbTransaction): Promise<void> {
    const inserted = await tx.insert(notificationOutbox).values({
      actionId: ctx.action.id, userId: ctx.recipient.userId, payloadJson,
    }).onConflictDoNothing().returning({ id: notificationOutbox.id });
    if (inserted.length) await this.insertAlertRows(ctx, payloadJson, "pending", tx);
  }

  /** Due by the database's own clock: a row inserted a moment ago has an
   * `available_at` with microseconds, which a millisecond JS time taken
   * right after the commit can still be behind (the first drain then found
   * nothing and the alert waited for the 5 s poll). */
  private due() {
    return or(
      and(eq(notificationOutbox.status, "pending"), lte(notificationOutbox.availableAt, sql`now()`)),
      and(eq(notificationOutbox.status, "processing"), lte(notificationOutbox.lockedUntil, sql`now()`)),
    );
  }

  /** Candidates only, oldest first: each row still needs an atomic claim before sending. */
  findDue(actionId?: bigint, limit = DELIVERY_BATCH) {
    return this.db.select({ id: notificationOutbox.id }).from(notificationOutbox)
      .where(and(this.due(), actionId === undefined ? undefined : eq(notificationOutbox.actionId, actionId)))
      .orderBy(notificationOutbox.id).limit(limit);
  }

  /** Return undefined when another sender already owns the unexpired lease. */
  async claim(id: bigint, leaseToken: string, leaseMs: number) {
    const [row] = await this.db.update(notificationOutbox).set({ status: "processing", leaseToken,
      lockedUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`, attempts: sql`${notificationOutbox.attempts} + 1`,
    }).where(and(eq(notificationOutbox.id, id), this.due())).returning();
    return row;
  }

  /** Marks a send as started, under the caller's lease; false when the
   * lease was lost (another sender owns the row now: do not send). */
  async markSending(id: bigint, leaseToken: string): Promise<boolean> {
    const rows = await this.db.update(notificationOutbox).set({ sendStartedAt: sql`now()` })
      .where(and(eq(notificationOutbox.id, id), eq(notificationOutbox.leaseToken, leaseToken), eq(notificationOutbox.status, "processing")))
      .returning({ id: notificationOutbox.id });
    return rows.length > 0;
  }

  /** The send is known not to have reached Telegram (it answered with an
   * error, or the connection never opened): a later attempt may send. */
  async clearSending(id: bigint, leaseToken: string): Promise<void> {
    await this.db.update(notificationOutbox).set({ sendStartedAt: null })
      .where(and(eq(notificationOutbox.id, id), eq(notificationOutbox.leaseToken, leaseToken)));
  }

  /** Always query current persisted authorization, including before an immediate retry. */
  async enabledRecipient(userId: number) {
    const [row] = await this.db.select({ id: users.id, role: users.role }).from(users)
      .where(and(eq(users.id, userId), isNull(users.disabledAt)));
    return row;
  }

  async enabledChannel(userId: number, target?: string) {
    const [row] = await this.db.select().from(notificationChannels).where(and(
      eq(notificationChannels.userId, userId), eq(notificationChannels.kind, "telegram"),
      eq(notificationChannels.enabled, true), target === undefined ? undefined : eq(notificationChannels.target, target),
    ));
    return row;
  }

  async notificationSettings() {
    const [row] = await this.db.select().from(appSettings).where(eq(appSettings.key, "notifications"));
    return row;
  }

  async action(id: bigint) {
    const [row] = await this.db.select().from(actions).where(eq(actions.id, id));
    return row;
  }

  async enabledFavorite(userId: number, chain: string, address: string) {
    const [row] = await this.db.select().from(userFavorites).where(and(
      eq(userFavorites.userId, userId), eq(userFavorites.chain, chain),
      eq(userFavorites.address, address), eq(userFavorites.alertEnabled, true),
    ));
    return row;
  }

  /** Atomically publish the owning lease's result and matching alert log state.
   * An expired sender whose lease was replaced updates neither table. */
  async recordDelivery(tx: DbTransaction, row: DeliveryRow, leaseToken: string, result: {
    status: "sent" | "dry_run" | "failed";
    pending: boolean;
    availableAt: Date;
    reason?: string;
  }): Promise<void> {
    const { status, pending, availableAt, reason } = result;
    const updated = await tx.update(notificationOutbox).set({ status: pending ? "pending" : status,
      availableAt, lockedUntil: null, leaseToken: null, lastError: reason ?? null,
      // A retry is only scheduled after a send known not to have arrived.
      ...(pending ? { sendStartedAt: null } : {}),
    }).where(and(eq(notificationOutbox.id, row.id), eq(notificationOutbox.leaseToken, leaseToken))).returning({ id: notificationOutbox.id });
    if (!updated.length || row.actionId === null) return;
    await tx.update(alerts).set({ sendStatus: status, sentAt: new Date(),
      payloadJson: reason ? { ...row.payloadJson, reason } : row.payloadJson,
    }).where(and(eq(alerts.actionId, row.actionId), eq(alerts.userId, row.userId)));
  }

  private async insertAlertRows(
    ctx: AlertContext,
    payloadJson: Record<string, unknown>,
    sendStatus: "sent" | "dry_run" | "failed" | "pending",
    db: DbTransaction,
  ): Promise<void> {
    // sent_at is "when this attempt happened" for every outcome, so the log
    // sorts failed rows in place too.
    const sentAt = sendStatus === "pending" ? null : new Date();
    const row = {
      userId: ctx.recipient.userId,
      chain: ctx.action.chain,
      address: ctx.action.address,
      coin: ctx.action.coin,
      actionId: ctx.action.id,
      payloadJson,
      sentAt,
      sendStatus,
    };
    const ruleIds: (number | null)[] = ctx.rules.length > 0 ? ctx.rules.map((r) => r.id) : [null];
    await db.insert(alerts).values(ruleIds.map((ruleId) => ({ ...row, ruleId })));
  }
}
