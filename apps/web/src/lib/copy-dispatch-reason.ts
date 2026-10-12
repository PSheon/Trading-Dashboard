import type { MessageKey } from "@/i18n/messages";
import { copyCodeText, type CopyTexts } from "./copy-error-text";

/** A live copy's skip reasons in the copy admin's existing words (every
 * locale has them): a live code showed as "another reason" on Stage
 * (2026-10-12, a close the follower never held). */
const LIVE_REASONS: Readonly<Record<string, string>> = {
  no_follower_position: "nothing_to_reduce", below_min_notional: "below_min_notional", signal_expired: "stale_signal",
  merged_signal_expired: "stale_signal", merged_into_adjustment: "superseded", copy_stopping: "strategy_stopping",
  live_market_hip3_unsupported: "symbol_not_allowed",
};

/** Only dispatch reasons describe an original trade claim, not API failures or fill proof. */
export function copyDispatchReasonText(
  texts: CopyTexts,
  code: string,
  t: (key: MessageKey) => string,
): string {
  if (code === "fixed_trade_already_claimed") return t("liveCopyUi.fixedTradeAlreadyClaimed");
  const live = Object.hasOwn(LIVE_REASONS, code) ? LIVE_REASONS[code] : undefined;
  return copyCodeText(texts, code) ?? (live ? t(`copyAdmin.reasons.${live}` as MessageKey) : texts.extra.refusal);
}
