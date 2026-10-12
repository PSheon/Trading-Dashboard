import { expect, it } from "vitest";
import { LOCALES } from "@/i18n/config";
import { catalogs, type MessageKey } from "@/i18n/messages";
import { copyErrorMessages } from "@/i18n/copy-errors";
import { liveSetupMessages } from "@/i18n/live-setup";
import { copyDispatchReasonText } from "@/lib/copy-dispatch-reason";
import { copyCodeText, copyErrorText } from "@/lib/copy-error-text";
import { ApiError } from "@/lib/api";
it.each(LOCALES)(
  "maps the exact claimed original trade only as a dispatch reason in %s",
  (locale) => {
    const texts = {
        live: liveSetupMessages[locale],
        extra: copyErrorMessages[locale],
      },
      t = (key: MessageKey) => {
        const value = key
          .split(".")
          .reduce<unknown>(
            (node, part) => (node as Record<string, unknown>)?.[part],
            catalogs[locale],
          );
        return typeof value === "string" ? value : key;
      };
    expect(
      copyDispatchReasonText(texts, "fixed_trade_already_claimed", t),
    ).toBe(catalogs[locale].liveCopyUi.fixedTradeAlreadyClaimed);
    expect(
      copyDispatchReasonText(texts, "fixed_trade_already_claimed_other", t),
    ).toBe(texts.extra.refusal);
    // A live skip reason has its own words, never "another reason" (Stage 2026-10-12).
    expect(copyDispatchReasonText(texts, "no_follower_position", t)).toBe(catalogs[locale].copyAdmin.reasons.nothing_to_reduce);
    for (const code of ["below_min_notional", "signal_expired", "merged_into_adjustment", "copy_stopping", "live_market_hip3_unsupported"])
      expect(copyDispatchReasonText(texts, code, t)).not.toBe(texts.extra.refusal);
    expect(copyDispatchReasonText(texts, "consent_expired", t)).toBe(
      texts.live.errors.consent_expired,
    );
    expect(copyCodeText(texts, "fixed_trade_already_claimed")).toBeNull();
    expect(
      copyErrorText(
        texts,
        new ApiError(409, "untrusted", { code: "fixed_trade_already_claimed" }),
      ),
    ).toBe(texts.live.errors.generic);
  },
);

it.each(LOCALES)("explains a close refused after Hyperliquid liquidated the copy in %s (CP-EXE-16)", (locale) => {
  const texts = { live: liveSetupMessages[locale], extra: copyErrorMessages[locale] };
  const t = (key: MessageKey) => key;
  expect(copyDispatchReasonText(texts, "position_liquidated", t)).toBe(texts.extra.codes.position_liquidated);
  expect(copyDispatchReasonText(texts, "position_liquidated", t)).not.toBe(texts.extra.refusal);
});
