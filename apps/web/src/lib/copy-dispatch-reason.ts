import type { MessageKey } from "@/i18n/messages";
import { copyCodeText, type CopyTexts } from "./copy-error-text";

/** Only dispatch reasons describe an original trade claim, not API failures or fill proof. */
export function copyDispatchReasonText(
  texts: CopyTexts,
  code: string,
  t: (key: MessageKey) => string,
): string {
  return code === "fixed_trade_already_claimed"
    ? t("liveCopyUi.fixedTradeAlreadyClaimed")
    : (copyCodeText(texts, code) ?? texts.extra.refusal);
}
