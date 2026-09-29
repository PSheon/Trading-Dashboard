import { Inject, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { and, eq, inArray, max } from "drizzle-orm";
import {
  alertRules,
  alerts,
  leaders,
  notificationChannels,
  userFavorites,
  users,
  flatOrPctParamsSchema,
  type AlertRuleKind,
} from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { NotifyService } from "../notify/notify.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { WatcherService } from "../watcher/watcher.service.js";
import { ACTION_CREATED_EVENT, type ActionCreatedEvent } from "../watcher/action-created.event.js";

type AlertRuleRow = typeof alertRules.$inferSelect;
type LeaderRow = typeof leaders.$inferSelect;

/** Address-scope rule kinds this M2 task implements. R4/R5 are real PRD
 * kinds but out of scope for M2 (not evaluated even if a row somehow
 * exists for them — see `matches()`'s `default: return false`). */
const ADDRESS_SCOPE_KINDS_IN_SCOPE: AlertRuleKind[] = ["R1", "R2", "R3"];

/**
 * Reads `actions` and decides who gets a Telegram notification (§4.3 R1–R3).
 * Rules evaluate synchronously, in-process, driven by the Watcher's
 * `action.created` event — no polling of the `actions` table, no queue
 * (§8 延遲: ≤5s fill-to-Telegram).
 *
 * Rules are per user. For each action the recipients are the users who
 * favorited that address, plus every admin when an admin imported it
 * (`leaders.source = 'import'`). Each recipient's own enabled rules are
 * evaluated, with their own cooldowns, and all of a recipient's matching
 * rules go out as ONE message to that recipient's Telegram channel.
 *
 * The admin's `notifications.alertsEnabled` switch turns all of this off:
 * nothing is evaluated, sent or logged. System messages are unaffected
 * (NotifyService.sendSystemMessage doesn't come through here).
 */
@Injectable()
export class RulesService {
  private readonly logger = new Logger(RulesService.name);

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly watcher: WatcherService,
    private readonly notify: NotifyService,
    private readonly settings: SettingsService,
  ) {}

  @OnEvent(ACTION_CREATED_EVENT)
  async onActionCreated(action: ActionCreatedEvent): Promise<void> {
    await this.evaluateAction(action);
  }

  /** Evaluates every recipient's enabled, tier-applicable address-scope
   * rules (R1–R3) against one newly-persisted action. One rule's
   * evaluation failure never stops the others; one recipient's send never
   * delays another's (sends run concurrently, and NotifyService never
   * throws). Each matching rule still gets its own `alerts` row (N2). */
  async evaluateAction(action: ActionCreatedEvent): Promise<void> {
    if (!(await this.settings.get("notifications")).alertsEnabled) return;

    const leader = await this.getLeader(action.chain, action.address);
    if (!leader) {
      // Shouldn't happen (an action only exists for a watched address) —
      // defensive no-op if a leader row is deleted mid-flight.
      return;
    }

    const recipientIds = await this.recipientsFor(leader);
    if (recipientIds.length === 0) return;

    const rules = await this.getApplicableAddressRules(recipientIds, leader.tier);
    if (rules.length === 0) return;

    const [lastSentByRule, chatIdByUser] = await Promise.all([
      this.lastSentByRule(
        rules.map((r) => r.id),
        action,
      ),
      this.telegramChatIds(recipientIds),
    ]);
    const equityUsd = this.watcher.getEquityUsd(action.address);
    const now = Date.now();

    const firingByUser = new Map<number, AlertRuleRow[]>();
    for (const rule of rules) {
      try {
        if (!this.matches(rule, action, equityUsd)) continue;
        const lastSent = lastSentByRule.get(rule.id);
        if (lastSent && (now - lastSent.getTime()) / 1000 < rule.cooldownS) continue;
        const userId = rule.userId as number;
        firingByUser.set(userId, [...(firingByUser.get(userId) ?? []), rule]);
      } catch (error) {
        this.logger.error(
          `Rule evaluation failed for rule ${rule.id} (${rule.kind}) / ${action.address} / ${action.coin}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    await Promise.all(
      [...firingByUser].map(async ([userId, firing]) => {
        try {
          await this.notify.notifyRulesFire({
            rules: firing,
            action,
            leader,
            recipient: { userId, telegramChatId: chatIdByUser.get(userId) ?? null },
          });
        } catch (error) {
          this.logger.error(
            `notifyRulesFire failed for user ${userId} [${firing.map((r) => r.kind).join(",")}] / ${action.address} / ${action.coin}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );
  }

  /** R6–R9 (group rules) are out of scope for M2 — no caller wires this up
   * yet; left as the M1 scaffold's not-implemented stub. */
  async evaluateGroupRules(): Promise<void> {
    throw new Error("not implemented — R6-R9 are out of scope for M2");
  }

  /** Users who favorited this address, plus every admin for an imported
   * leader. */
  async recipientsFor(leader: Pick<LeaderRow, "chain" | "address" | "source">): Promise<number[]> {
    const [favoriters, admins] = await Promise.all([
      this.db
        .select({ userId: userFavorites.userId })
        .from(userFavorites)
        .where(and(eq(userFavorites.chain, leader.chain), eq(userFavorites.address, leader.address))),
      leader.source === "import"
        ? this.db.select({ userId: users.id }).from(users).where(eq(users.role, "admin"))
        : Promise.resolve([]),
    ]);
    return [...new Set([...favoriters, ...admins].map((r) => r.userId))];
  }

  private matches(rule: AlertRuleRow, action: ActionCreatedEvent, equityUsd: number | null): boolean {
    switch (rule.kind) {
      case "R1": {
        if (action.kind !== "open") return false;
        return this.meetsFlatOrPctThreshold(rule, action, equityUsd);
      }
      case "R2":
        return action.kind === "flip";
      case "R3":
        return this.meetsFlatOrPctThreshold(rule, action, equityUsd);
      default:
        // R4-R9: not evaluated in M2 even if a row exists for them.
        return false;
    }
  }

  /** R1/R3 share the identical "notional >= min(flatThresholdUsd,
   * equityUsd * pctThreshold)" condition (§11 決策紀錄 "R1 門檻"; the task's
   * own note confirms "A≥X or A≥Y" and "A≥min(X,Y)" are the same
   * condition — R1 and R3 differ only in their seeded params, not in this
   * comparison). If `equityUsd` is unavailable (no cached poll state yet
   * for this address), the equity% branch can't be computed — fall back to
   * the flat threshold alone rather than guessing; documented judgment
   * call, and a safe direction (harder to fire, not easier). */
  private meetsFlatOrPctThreshold(
    rule: AlertRuleRow,
    action: ActionCreatedEvent,
    equityUsd: number | null,
  ): boolean {
    const params = flatOrPctParamsSchema.safeParse(rule.paramsJson);
    if (!params.success) {
      this.logger.error(`Rule ${rule.id} (${rule.kind}) has invalid params_json — skipping: ${params.error.message}`);
      return false;
    }
    const threshold =
      equityUsd === null
        ? params.data.flatThresholdUsd
        : Math.min(params.data.flatThresholdUsd, equityUsd * params.data.pctThreshold);
    return Number(action.notionalUsd) >= threshold;
  }

  /** Cooldown source of truth is the DB (`alerts.sent_at`), not memory, so
   * a restart doesn't burst duplicate alerts. Rule rows are per user, so
   * keying by rule id makes the cooldown per (user, rule, address, coin). */
  private async lastSentByRule(ruleIds: number[], action: ActionCreatedEvent): Promise<Map<number, Date>> {
    const rows = await this.db
      .select({ ruleId: alerts.ruleId, lastSentAt: max(alerts.sentAt) })
      .from(alerts)
      .where(
        and(inArray(alerts.ruleId, ruleIds), eq(alerts.address, action.address), eq(alerts.coin, action.coin)),
      )
      .groupBy(alerts.ruleId);
    const result = new Map<number, Date>();
    for (const row of rows) if (row.lastSentAt) result.set(row.ruleId, new Date(row.lastSentAt));
    return result;
  }

  private async telegramChatIds(userIds: number[]): Promise<Map<number, string>> {
    const rows = await this.db
      .select({ userId: notificationChannels.userId, target: notificationChannels.target })
      .from(notificationChannels)
      .where(
        and(
          inArray(notificationChannels.userId, userIds),
          eq(notificationChannels.kind, "telegram"),
          eq(notificationChannels.enabled, true),
        ),
      );
    return new Map(rows.map((r) => [r.userId, r.target]));
  }

  private async getLeader(chain: string, address: string): Promise<LeaderRow | undefined> {
    const [row] = await this.db
      .select()
      .from(leaders)
      .where(and(eq(leaders.chain, chain), eq(leaders.address, address)))
      .limit(1);
    return row;
  }

  /** The recipients' enabled, address-scope, in-scope rules whose `tiers[]`
   * include this leader's tier. Filtered in JS: a few rows per user. */
  private async getApplicableAddressRules(userIds: number[], tier: LeaderRow["tier"]): Promise<AlertRuleRow[]> {
    const rows = await this.db
      .select()
      .from(alertRules)
      .where(
        and(
          inArray(alertRules.userId, userIds),
          eq(alertRules.scope, "address"),
          eq(alertRules.enabled, true),
        ),
      );
    return rows.filter(
      (r) => ADDRESS_SCOPE_KINDS_IN_SCOPE.includes(r.kind) && r.tiers.includes(tier),
    );
  }
}
