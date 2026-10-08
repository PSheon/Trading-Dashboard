import type { Translate } from "@/i18n/provider";
import type { CopyOrderView } from "@/lib/contracts";
import { copyReasonText } from "@/lib/admin-copy";

const policyReasons = new Set([
  "platform_paused", "platform_reduce_only", "user_paused", "user_reduce_only", "strategy_paused", "strategy_reduce_only",
  "symbol_blocked", "symbol_not_allowed", "stale_signal", "price_moved", "frequency", "zero_size", "below_min_notional", "reduce_only_no_position",
]);

/** A reason describes the remainder too: never erase evidence of a prior fill.
 * Policy refusal is not evidence that an exchange order was never submitted. */
export function copyOrderPresentation(order: Pick<CopyOrderView, "status" | "reason" | "filledSize">, t: Translate) {
  const terminal = order.status === "rejected" || order.status === "cancelled";
  const base = order.reason?.replace(/_before_(?:submit|fill)$/, "") ?? "";
  const policy = terminal && (policyReasons.has(base) || /^below_min_after_(?:max_order|max_coin_exposure|max_user_exposure|max_strategy_exposure|available_funds)$/.test(base));
  const refused = policy && order.filledSize === 0;
  // The admin formatter also accepts scoped commands; only send actual command
  // names to that path so object prototype names cannot become catalog keys.
  const unknownControl = /^(?:platform|user|strategy)_/.test(base)
    && !/^(?:platform|user|strategy)_(?:paused|reduce_only|pause|stop|pause_new_risk|cancel_pending|close_positions|resume)$/.test(base);
  const translated = base && !unknownControl ? copyReasonText(base, t) : base;
  return {
    status: refused ? t("portfolio.copy.order.riskRefused") : t(`portfolio.copy.order.statusName.${order.status}`),
    tone: order.status === "filled" || order.status === "partial" ? "text-positive" : policy ? "text-warning" : terminal ? "text-negative" : "text-muted-foreground",
    reason: order.status === "filled" || !order.reason ? null : translated !== base ? translated : t("portfolio.copy.order.unknownReason"),
  };
}
