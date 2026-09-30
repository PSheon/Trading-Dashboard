import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { AlertRuleKind } from "@trading-dashboard/shared/contracts";

import { UnitOfWork, type DbTransaction } from "../db/unit-of-work.js";
import { tradeSideOf } from "../notify/message-template.js";
import { NotifyService } from "../notify/notify.service.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { AccountStateService } from "../watcher/account-state.service.js";
import { ACTION_CREATED_EVENT, type ActionCreatedEvent } from "../watcher/action-created.event.js";
import { ruleMatches } from "./rule-policy.js";
import { RulesRepository, type AlertRuleRow, type LeaderRow } from "./rules.repository.js";

/** Address-scope rule kinds that are evaluated. R4/R5 are real PRD kinds
 * but not implemented; ruleMatches rejects them. */
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
 * driven by the Watcher's `action.created` event and durable outbox replay.
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
    private readonly repository: RulesRepository,
    private readonly unitOfWork: UnitOfWork,
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
    await this.unitOfWork.run(async (tx) => {
      await this.repository.lockActionScope(tx, action);
      const event = await this.repository.actionEvent(tx, action.id);
      if (event?.status === "done") return;
      const equityUsd = event ? (event.equityUsd === null ? null : Number(event.equityUsd)) : this.accounts.getEquityUsd(action.address);
      await this.evaluateInTransaction(action, tx, equityUsd);
      await this.repository.markDone(tx, action.id);
    });
    await this.notify.deliverAction(action.id);
  }

  private async evaluateInTransaction(action: ActionCreatedEvent, db: DbTransaction, equityUsd: number | null): Promise<void> {
    if (!(await this.settings.get("notifications")).alertsEnabled) return;

    const leader = await this.repository.getLeader(action.chain, action.address, db);
    // An action only exists for a watched address; a leader deleted
    // mid-flight is a no-op.
    if (!leader) return;

    // One PostgreSQL transaction owns one connection; issue queries sequentially.
    const favoriteUserIds = await this.favoriteRecipients(action, db);
    const ruleHits = leader.source === "import"
      ? await this.adminRuleHits(action, leader, db, equityUsd)
      : new Map<number, AlertRuleRow[]>();

    const recipients = new Map<number, Recipient>();
    for (const userId of favoriteUserIds) recipients.set(userId, { favorite: true, rules: [] });
    for (const [userId, rules] of ruleHits) {
      recipients.set(userId, { favorite: recipients.get(userId)?.favorite ?? false, rules });
    }
    if (recipients.size === 0) return;

    const contacts = await this.repository.contacts([...recipients.keys()], db);
    const traderName = await this.traderName(leader, db);
    for (const [userId, { favorite, rules }] of recipients) {
      await this.notify.notifyAlert({
        action,
        traderName,
        recipient: {
          userId,
          telegramChatId: contacts.get(userId)?.chatId ?? null,
          locale: contacts.get(userId)?.locale ?? "zh-TW",
        },
        rules,
        favorite,
      }, db);
    }
  }

  /** R6–R9 (group rules) are not implemented; no caller wires this up. */
  async evaluateGroupRules(): Promise<void> {
    throw new Error("not implemented — R6-R9 are out of scope");
  }

  /** Users whose alert on this trader matches the action's side and size,
   * and who aren't inside the burst guard. Marks them as alerted. */
  private async favoriteRecipients(action: ActionCreatedEvent, db: DbTransaction): Promise<number[]> {
    const rows = await this.repository.favoriteCandidates(action, db);

    const side = tradeSideOf(action);
    const notional = Number(action.notionalUsd);
    const now = Date.now();
    const out: number[] = [];
    for (const row of rows) {
      if (row.sides !== "both" && row.sides !== side) continue;
      if (row.minUsd !== null && notional < Number(row.minUsd)) continue;
      // Reservation and notification enqueue share the address/coin transaction lock.
      const key = `${row.userId}|${action.chain}|${action.address}|${action.coin}`;
      if (!(await this.repository.reserveCooldown(db, `favorite|${key}`, FAVORITE_BURST_GUARD_MS, now))) continue;
      out.push(row.userId);
    }
    return out;
  }

  /** Imported leader: each admin → the default rules that fire for them
   * (matching and outside that admin's cooldown for the rule). */
  private async adminRuleHits(action: ActionCreatedEvent, leader: LeaderRow, db: DbTransaction, equityUsd: number | null): Promise<Map<number, AlertRuleRow[]>> {
    const hits = new Map<number, AlertRuleRow[]>();
    const admins = await this.repository.enabledAdmins(db);
    const rules = await this.getApplicableDefaultRules(leader.tier, db);
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
    const lastSent = await this.repository.lastSent(
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
        if (await this.repository.reserveCooldown(db, key, rule.cooldownS * 1000, now)) firing.push(rule);
      }
      if (firing.length > 0) hits.set(userId, firing);
    }
    return hits;
  }

  /** The admin's label, else the leaderboard's display name. */
  private async traderName(leader: LeaderRow, db: DbTransaction): Promise<string | null> {
    if (leader.label) return leader.label;
    return this.repository.displayName(leader, db);
  }

  /** Enabled, address-scope, implemented default rules whose `tiers[]`
   * include this leader's tier. */
  private async getApplicableDefaultRules(tier: LeaderRow["tier"], db: DbTransaction): Promise<AlertRuleRow[]> {
    const rows = await this.repository.enabledDefaultRules(db);
    return rows.filter((r) => ADDRESS_SCOPE_KINDS_IN_SCOPE.includes(r.kind) && r.tiers.includes(tier));
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
