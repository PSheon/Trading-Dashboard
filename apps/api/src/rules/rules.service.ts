import { Optional } from "@nestjs/common";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { and, eq, inArray, isNull, max, sql } from "drizzle-orm";
import {
  actionOutbox,
  notificationCooldowns,
  alertRules,
  alerts,
  leaders,
  notificationChannels,
  traderStats,
  userFavorites,
  users,
} from "@trading-dashboard/shared/database";
import { type AlertRuleKind, type Locale } from "@trading-dashboard/shared/contracts";

import type { DbOrTx } from "../watcher/action-store.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { tradeSideOf } from "../notify/message-template.js";
import { NotifyService } from "../notify/notify.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { AccountStateService } from "../watcher/account-state.service.js";
import { ruleMatches } from "./rule-policy.js";
import { ACTION_CREATED_EVENT, type ActionCreatedEvent } from "../watcher/action-created.event.js";

type AlertRuleRow = typeof alertRules.$inferSelect;
type LeaderRow = typeof leaders.$inferSelect;

/** Address-scope rule kinds that are evaluated. R4/R5 are real PRD kinds
 * but not implemented (see `matches()`'s `default: return false`). */
const ADDRESS_SCOPE_KINDS_IN_SCOPE: AlertRuleKind[] = ["R1", "R2", "R3"];

/** A favorite alert fires at most once per (user, trader, coin) in this
 * window. Actions are already 1 s aggregates; this only stops a trader who
 * fires several orders in a row from sending a burst. */
export const FAVORITE_BURST_GUARD_MS = 10_000;

interface Recipient {
  favorite: boolean;
  rules: AlertRuleRow[];
}

/**
 * Decides who gets a Telegram message for each new action, in-process,
 * driven by the Watcher's `action.created` event (≤5 s fill-to-Telegram).
 *
 * Two ways to receive one:
 * - **Favorite alerts** (CopyDog-style): every user with an alert switched
 *   on for this trader, filtered by their side (buy/sell/both) and minimum
 *   notional, with a short per-(user, trader, coin) burst guard.
 * - **Admins, imported leaders**: for `leaders.source = 'import'`, every
 *   admin gets the default rules (`alert_rules` with no owner, R1–R3) with
 *   each rule's cooldown per admin.
 *
 * Someone who qualifies both ways gets one message. The admin's
 * `notifications.alertsEnabled` switch turns all of this off: nothing is
 * evaluated, sent or logged. System messages are unaffected.
 */
@Injectable()
export class RulesService {
  private readonly logger = new Logger(RulesService.name);

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    @Inject(AccountStateService) private readonly accounts: Pick<AccountStateService, "getEquityUsd">,
    private readonly notify: NotifyService,
    private readonly settings: SettingsService,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}

  @OnEvent(ACTION_CREATED_EVENT)
  async onActionCreated(action: ActionCreatedEvent): Promise<void> {
    // The emitter doesn't await listeners; a rejection here must not become
    // an unhandled one.
    try {
      await this.evaluateAction(action);
    } catch (error) {
      this.logger.error(`Alert evaluation failed for ${action.address} / ${action.coin}: ${errorText(error)}`);
    }
  }

  /** Atomically evaluate recipients and reserve their deliveries, then send
   * outside the transaction. A worker can replay interrupted evaluations. */
  async evaluateAction(action: ActionCreatedEvent): Promise<void> {
    if (this.jobs.stopping) return;
    return this.jobs.run(() => this.evaluate(action));
  }

  private async evaluate(action: ActionCreatedEvent): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Serialize reservation + enqueue, including first-ever cooldown keys.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(73105, hashtext(${`${action.chain}|${action.address}|${action.coin}`}))`);
      const [event] = await tx.select().from(actionOutbox).where(eq(actionOutbox.actionId, action.id));
      if (event?.status === "done") return;
      const equityUsd = event ? (event.equityUsd === null ? null : Number(event.equityUsd)) : this.accounts.getEquityUsd(action.address);
      await this.evaluateInTransaction(action, tx, equityUsd);
      await tx.update(actionOutbox).set({ status: "done", lockedUntil: null, lastError: null }).where(eq(actionOutbox.actionId, action.id));
    });
    await this.notify.deliverAction(action.id);
  }

  private async evaluateInTransaction(action: ActionCreatedEvent, db: DbOrTx, equityUsd: number | null): Promise<void> {
    if (!(await this.settings.get("notifications")).alertsEnabled) return;

    const leader = await this.getLeader(action.chain, action.address, db);
    // An action only exists for a watched address; a leader deleted
    // mid-flight is a no-op.
    if (!leader) return;

    const [favoriteUserIds, ruleHits] = await Promise.all([
      this.favoriteRecipients(action, db),
      leader.source === "import" ? this.adminRuleHits(action, leader, db, equityUsd) : Promise.resolve(new Map<number, AlertRuleRow[]>()),
    ]);

    const recipients = new Map<number, Recipient>();
    for (const userId of favoriteUserIds) recipients.set(userId, { favorite: true, rules: [] });
    for (const [userId, rules] of ruleHits) {
      recipients.set(userId, { favorite: recipients.get(userId)?.favorite ?? false, rules });
    }
    if (recipients.size === 0) return;

    const [contacts, traderName] = await Promise.all([
      this.contacts([...recipients.keys()], db),
      this.traderName(leader, db),
    ]);

    await Promise.all(
      [...recipients].map(([userId, { favorite, rules }]) =>
        this.notify.notifyAlert({
          action,
          traderName,
          recipient: {
            userId,
            telegramChatId: contacts.get(userId)?.chatId ?? null,
            locale: contacts.get(userId)?.locale ?? "zh-TW",
          },
          rules,
          favorite,
        }, db),
      ),
    );
  }

  /** R6–R9 (group rules) are not implemented; no caller wires this up. */
  async evaluateGroupRules(): Promise<void> {
    throw new Error("not implemented — R6-R9 are out of scope");
  }

  /** Users whose alert on this trader matches the action's side and size,
   * and who aren't inside the burst guard. Marks them as alerted. */
  private async favoriteRecipients(action: ActionCreatedEvent, db: DbOrTx): Promise<number[]> {
    const rows = await db
      .select({
        userId: userFavorites.userId,
        sides: userFavorites.alertSides,
        minUsd: userFavorites.alertMinUsd,
      })
      .from(userFavorites)
      .innerJoin(users, eq(users.id, userFavorites.userId))
      .where(
        and(
          eq(userFavorites.chain, action.chain),
          eq(userFavorites.address, action.address),
          eq(userFavorites.alertEnabled, true),
          isNull(users.disabledAt),
        ),
      );

    const side = tradeSideOf(action);
    const notional = Number(action.notionalUsd);
    const now = Date.now();
    const out: number[] = [];
    for (const row of rows) {
      if (row.sides !== "both" && row.sides !== side) continue;
      if (row.minUsd !== null && notional < Number(row.minUsd)) continue;
      // Reservation and notification enqueue share the address/coin transaction lock.
      const key = `${row.userId}|${action.chain}|${action.address}|${action.coin}`;
      if (!(await this.reserveCooldown(db, `favorite|${key}`, FAVORITE_BURST_GUARD_MS, now))) continue;
      out.push(row.userId);
    }
    return out;
  }

  private async reserveCooldown(db: DbOrTx, key: string, milliseconds: number, now: number): Promise<boolean> {
    const rows = await db.insert(notificationCooldowns).values({ key, reservedAt: new Date(now) })
      .onConflictDoUpdate({ target: notificationCooldowns.key, set: { reservedAt: new Date(now) },
        setWhere: sql`${notificationCooldowns.reservedAt} <= ${new Date(now - milliseconds)}`,
      }).returning({ key: notificationCooldowns.key });
    return rows.length > 0;
  }

  /** Imported leader: each admin → the default rules that fire for them
   * (matching and outside that admin's cooldown for the rule). */
  private async adminRuleHits(action: ActionCreatedEvent, leader: LeaderRow, db: DbOrTx, equityUsd: number | null): Promise<Map<number, AlertRuleRow[]>> {
    const hits = new Map<number, AlertRuleRow[]>();
    const [admins, rules] = await Promise.all([
      db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), isNull(users.disabledAt))),
      this.getApplicableDefaultRules(leader.tier, db),
    ]);
    if (admins.length === 0 || rules.length === 0) return hits;

    const matching = rules.filter((rule) => {
      try {
        return ruleMatches(rule, action, equityUsd);
      } catch (error) {
        this.logger.error(
          `Rule evaluation failed for rule ${rule.id} (${rule.kind}) / ${action.address} / ${action.coin}: ${errorText(error)}`,
        );
        return false;
      }
    });
    if (matching.length === 0) return hits;

    const adminIds = admins.map((a) => a.id);
    const lastSent = await this.lastSent(
      adminIds,
      matching.map((r) => r.id),
      action,
      db,
    );
    const now = Date.now();
    for (const userId of adminIds) {
      const firing: AlertRuleRow[] = [];
      for (const rule of matching) {
        const last = lastSent.get(`${userId}|${rule.id}`);
        if (last && (now - last.getTime()) / 1000 < rule.cooldownS) continue;
        const key = `rule|${userId}|${rule.id}|${action.chain}|${action.address}|${action.coin}`;
        if (await this.reserveCooldown(db, key, rule.cooldownS * 1000, now)) firing.push(rule);
      }
      if (firing.length > 0) hits.set(userId, firing);
    }
    return hits;
  }

  /** Preserve cooldowns from pre-outbox alerts as well as new durable reservations.
   * Default rules are shared; cooldown remains per admin/address/coin. */
  private async lastSent(userIds: number[], ruleIds: number[], action: ActionCreatedEvent, db: DbOrTx): Promise<Map<string, Date>> {
    const rows = await db
      .select({ userId: alerts.userId, ruleId: alerts.ruleId, lastSentAt: max(alerts.sentAt) })
      .from(alerts)
      .where(
        and(
          inArray(alerts.userId, userIds),
          inArray(alerts.ruleId, ruleIds),
          eq(alerts.address, action.address),
          eq(alerts.coin, action.coin),
        ),
      )
      .groupBy(alerts.userId, alerts.ruleId);
    const result = new Map<string, Date>();
    for (const row of rows) {
      if (row.lastSentAt) result.set(`${row.userId}|${row.ruleId}`, new Date(row.lastSentAt));
    }
    return result;
  }

  /** Each recipient's locale and linked, enabled Telegram chat (if any). */
  private async contacts(userIds: number[], db: DbOrTx): Promise<Map<number, { locale: Locale; chatId: string | null }>> {
    const rows = await db
      .select({ userId: users.id, locale: users.locale, chatId: notificationChannels.target })
      .from(users)
      .leftJoin(
        notificationChannels,
        and(
          eq(notificationChannels.userId, users.id),
          eq(notificationChannels.kind, "telegram"),
          eq(notificationChannels.enabled, true),
        ),
      )
      .where(inArray(users.id, userIds));
    return new Map(rows.map((r) => [r.userId, { locale: r.locale, chatId: r.chatId }]));
  }

  /** The admin's label, else the leaderboard's display name. */
  private async traderName(leader: LeaderRow, db: DbOrTx): Promise<string | null> {
    if (leader.label) return leader.label;
    const [row] = await db
      .select({ displayName: traderStats.displayName })
      .from(traderStats)
      .where(and(eq(traderStats.chain, leader.chain), eq(traderStats.address, leader.address)));
    return row?.displayName ?? null;
  }

  private async getLeader(chain: string, address: string, db: DbOrTx): Promise<LeaderRow | undefined> {
    const [row] = await db
      .select()
      .from(leaders)
      .where(and(eq(leaders.chain, chain), eq(leaders.address, address)))
      .limit(1);
    return row;
  }

  /** Enabled, address-scope, implemented default rules whose `tiers[]`
   * include this leader's tier. */
  private async getApplicableDefaultRules(tier: LeaderRow["tier"], db: DbOrTx): Promise<AlertRuleRow[]> {
    const rows = await db
      .select()
      .from(alertRules)
      .where(and(isNull(alertRules.userId), eq(alertRules.scope, "address"), eq(alertRules.enabled, true)));
    return rows.filter((r) => ADDRESS_SCOPE_KINDS_IN_SCOPE.includes(r.kind) && r.tiers.includes(tier));
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
