import { Inject, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { and, desc, eq } from "drizzle-orm";
import {
  alertRules,
  alerts,
  leaders,
  flatOrPctParamsSchema,
  type AlertRuleKind,
} from "@trading-dashboard/shared";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { chatIdForRuleKind } from "../notify/chat-routing.js";
import { NotifyService } from "../notify/notify.service.js";
import { WatcherService } from "../watcher/watcher.service.js";
import { ACTION_CREATED_EVENT, type ActionCreatedEvent } from "../watcher/action-created.event.js";

type AlertRuleRow = typeof alertRules.$inferSelect;
type LeaderRow = typeof leaders.$inferSelect;

/** Address-scope rule kinds this M2 task implements. R4/R5 are real PRD
 * kinds but out of scope for M2 (not evaluated even if a row somehow
 * exists for them — see `matches()`'s `default: return false`). */
const ADDRESS_SCOPE_KINDS_IN_SCOPE: AlertRuleKind[] = ["R1", "R2", "R3"];

/**
 * Reads `actions` and decides whether to push a Telegram notification
 * (§4.3 R1–R3 for M2). Rules evaluate synchronously, in-process, driven by
 * the Watcher's `action.created` event (§1 of the M2 task) — no polling of
 * the `actions` table, no queue (§8 延遲: ≤5s fill-to-Telegram).
 */
@Injectable()
export class RulesService {
  private readonly logger = new Logger(RulesService.name);

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly watcher: WatcherService,
    private readonly notify: NotifyService,
  ) {}

  @OnEvent(ACTION_CREATED_EVENT)
  async onActionCreated(action: ActionCreatedEvent): Promise<void> {
    await this.evaluateAction(action);
  }

  /** Evaluates every enabled, tier-applicable address-scope rule (R1–R3)
   * against one newly-persisted action. Isolated per-rule try/catch for the
   * condition+cooldown check: one rule's evaluation failure must never stop
   * the others. Rules that end up matching (condition true AND each rule's
   * OWN cooldown independently not active) are then grouped by chat
   * destination and sent as ONE combined Telegram message per destination
   * — e.g. R1 and R3 both matching the same large `open` (or R2 and R3 both
   * matching the same `flip`) must not send two separate messages for one
   * action, even though each still gets its own `alerts` row (N2). */
  async evaluateAction(action: ActionCreatedEvent): Promise<void> {
    const leader = await this.getLeader(action.chain, action.address);
    if (!leader) {
      // Shouldn't happen (an action can only exist for a polled, and thus
      // leaders-table-present, address) — defensive no-op rather than a
      // crash if a leader row is deleted mid-flight.
      return;
    }

    const rules = await this.getApplicableAddressRules(leader.tier);
    const equityUsd = this.watcher.getEquityUsd(action.address);

    const firingRules: AlertRuleRow[] = [];
    for (const rule of rules) {
      try {
        if (!this.matches(rule, action, equityUsd)) continue;
        if (await this.isInCooldown(rule, action)) continue;
        firingRules.push(rule);
      } catch (error) {
        this.logger.error(
          `Rule evaluation failed for ${rule.kind} / ${action.address} / ${action.coin}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (firingRules.length === 0) return;

    const byChatId = new Map<string | undefined, AlertRuleRow[]>();
    for (const rule of firingRules) {
      const chatId = chatIdForRuleKind(rule.kind);
      const group = byChatId.get(chatId) ?? [];
      group.push(rule);
      byChatId.set(chatId, group);
    }

    for (const group of byChatId.values()) {
      try {
        await this.notify.notifyRulesFire({ rules: group, action, leader });
      } catch (error) {
        this.logger.error(
          `notifyRulesFire failed for [${group.map((r) => r.kind).join(",")}] / ${action.address} / ${action.coin}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** R6–R9 (group rules) are out of scope for M2 — no caller wires this up
   * yet; left as the M1 scaffold's not-implemented stub. */
  async evaluateGroupRules(): Promise<void> {
    throw new Error("not implemented — R6-R9 are out of scope for M2");
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

  /** Cooldown source-of-truth is the DB (`alerts.sent_at`), not in-memory
   * state, so a process restart doesn't cause a burst of duplicate
   * re-alerts (task's explicit instruction). */
  private async isInCooldown(rule: AlertRuleRow, action: ActionCreatedEvent): Promise<boolean> {
    const [last] = await this.db
      .select({ sentAt: alerts.sentAt })
      .from(alerts)
      .where(and(eq(alerts.ruleId, rule.id), eq(alerts.address, action.address), eq(alerts.coin, action.coin)))
      .orderBy(desc(alerts.sentAt))
      .limit(1);

    if (!last?.sentAt) return false;
    const elapsedSeconds = (Date.now() - last.sentAt.getTime()) / 1000;
    return elapsedSeconds < rule.cooldownS;
  }

  private async getLeader(chain: string, address: string): Promise<LeaderRow | undefined> {
    const [row] = await this.db
      .select()
      .from(leaders)
      .where(and(eq(leaders.chain, chain), eq(leaders.address, address)))
      .limit(1);
    return row;
  }

  /** Enabled, address-scope, in-M2-scope rules whose `tiers[]` includes
   * this leader's current tier. Fetched-then-filtered-in-JS rather than an
   * array-contains SQL predicate — rule-row volume is tiny (3 rows for
   * M2), not worth the query complexity. */
  private async getApplicableAddressRules(tier: LeaderRow["tier"]): Promise<AlertRuleRow[]> {
    const rows = await this.db
      .select()
      .from(alertRules)
      .where(and(eq(alertRules.scope, "address"), eq(alertRules.enabled, true)));
    return rows.filter(
      (r) => ADDRESS_SCOPE_KINDS_IN_SCOPE.includes(r.kind) && r.tiers.includes(tier),
    );
  }
}
