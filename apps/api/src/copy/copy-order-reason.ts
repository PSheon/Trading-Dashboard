/** Public terminal-order reasons are codes, never exception text. Unknown reasons
 * intentionally collapse to a fixed fallback at persistence and rendering. */
const reasons = new Set([
  "user_disabled", "risk_policy_invalid", "strategy_settings_invalid", "strategy_settings_changed",
  "strategy_paused", "strategy_stopping", "strategy_stopped", "strategy_reduce_only",
  "platform_paused", "platform_reduce_only", "user_paused", "user_reduce_only",
  "symbol_blocked", "symbol_not_allowed", "stale_price", "stale_signal", "no_price", "no_asset_info",
  "opposite_position", "missing_reservation", "max_per_trade", "reduce_only_no_position",
  "leader_equity_unknown", "no_per_trade_amount", "price_moved", "frequency", "zero_size",
  "below_min_notional", "below_min_after_rounding",
]);
const caps = "(?:max_order|max_coin_exposure|max_user_exposure|max_strategy_exposure|available_funds)";
const capped = new RegExp(`^(?:below_min_after_${caps}|risk_cap_${caps}(?:_${caps})*)$`);

export function publicOrderReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.length > 200) return "order_not_executed";
  const base = reason.replace(/_before_(?:submit|fill)$/, "");
  return reasons.has(base) || capped.test(base) ? reason : "order_not_executed";
}
