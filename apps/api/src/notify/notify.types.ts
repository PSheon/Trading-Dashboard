import type { actions, alertRules } from "@trading-dashboard/shared/database";
import type { Locale } from "@trading-dashboard/shared/contracts";

type ActionRow = typeof actions.$inferSelect;
type AlertRuleRow = typeof alertRules.$inferSelect;

export interface AlertRecipient {
  userId: number;
  /** The user's linked, enabled Telegram chat, or null when they have none. */
  telegramChatId: string | null;
  locale: Locale;
}

/**
 * One action, one recipient, one message. RulesService has already decided
 * this person gets it and why:
 * - `favorite`: their own alert on this trader matched (side, minimum);
 * - `rules`: default rules that matched, for an admin on an imported leader.
 * Both can be true for an admin who also set an alert; they still get one
 * message.
 */
export interface AlertContext {
  action: ActionRow;
  /** Leader label or leaderboard name; null → the short address. */
  traderName: string | null;
  recipient: AlertRecipient;
  rules: AlertRuleRow[];
  favorite: boolean;
}

