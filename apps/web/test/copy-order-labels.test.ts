import { describe, expect, it } from "vitest";

import { copyOrderPresentation } from "@/components/copy/copy-order-labels";
import { en } from "@/i18n/messages/en";
import { zhTW } from "@/i18n/messages/zh-TW";
import type { Translate } from "@/i18n/provider";
import { copyReasonText } from "@/lib/admin-copy";

function translator(messages: Record<string, unknown>): Translate {
  return ((key: string, values?: Record<string, string | number>) => {
    const text = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages);
    if (typeof text !== "string") return key;
    return text.replace(/\{(\w+)\}/g, (match, name: string) => (values && name in values ? String(values[name]) : match));
  }) as Translate;
}

const t = translator(zhTW);
const unknown = zhTW.portfolio.copy.order.unknownReason;
const refused = zhTW.portfolio.copy.order.riskRefused;

/** Every reason the api lets through `publicOrderReason` (apps/api/src/copy/copy-order-reason.ts). */
const publicReasons = [
  "user_disabled", "risk_policy_invalid", "strategy_settings_invalid", "strategy_settings_changed",
  "strategy_paused", "strategy_stopping", "strategy_stopped", "strategy_reduce_only",
  "platform_paused", "platform_reduce_only", "user_paused", "user_reduce_only",
  "symbol_blocked", "symbol_not_allowed", "stale_price", "stale_signal", "no_price", "no_asset_info",
  "opposite_position", "missing_reservation", "max_per_trade", "reduce_only_no_position",
  "leader_equity_unknown", "no_per_trade_amount", "price_moved", "frequency", "zero_size",
  "below_min_notional", "below_min_after_rounding",
];

describe("copy order reasons", () => {
  it("explains every public reason code, with and without the recheck suffix", () => {
    for (const code of publicReasons) {
      for (const reason of [code, `${code}_before_submit`, `${code}_before_fill`]) {
        const shown = copyOrderPresentation({ status: "rejected", reason, filledSize: 0 }, t).reason;
        expect(shown, reason).not.toBe(unknown);
        expect(shown, reason).not.toContain("_");
        expect(copyReasonText(reason, translator(en)), reason).not.toContain("_");
      }
    }
  });

  it("names the rounding minimum and a cap tightened before submission", () => {
    expect(copyReasonText("below_min_after_rounding", t)).toBe("依交易所精度取整後低於最小下單金額");
    expect(copyReasonText("risk_cap_max_strategy_exposure_before_submit", t)).toBe("送出前複核：「策略曝險上限」已收緊，原核准數量已取消");
    expect(copyReasonText("risk_cap_max_order_max_user_exposure", t)).toBe("「單筆上限、使用者總曝險上限」已收緊，原核准數量已取消");
    expect(copyReasonText("stale_price_before_submit", t)).toBe("送出前複核：價格資料已過時");
    expect(copyReasonText("stale_price_before_submit", translator(en))).toBe("Recheck before submission: Price data was stale");
  });

  it("counts minimum, rounding and cap refusals as risk checks, not as failures", () => {
    for (const reason of ["below_min_after_rounding", "risk_cap_max_strategy_exposure_before_submit", "below_min_after_max_strategy_exposure", "stale_price_before_submit"]) {
      const shown = copyOrderPresentation({ status: "rejected", reason, filledSize: 0 }, t);
      expect(shown.status, reason).toBe(refused);
      expect(shown.tone, reason).toBe("text-warning");
    }
  });

  it("never hides a prior partial fill behind a refusal", () => {
    const shown = copyOrderPresentation({ status: "cancelled", reason: "risk_cap_max_order_before_fill", filledSize: 0.4 }, t);
    expect(shown.status).toBe(zhTW.portfolio.copy.order.statusName.cancelled);
    expect(shown.reason).toBe("成交前複核：「單筆上限」已收緊，原核准數量已取消");
  });

  it("keeps the fallback for codes this build does not know", () => {
    for (const reason of ["order_not_executed", "exchange_said_no", "user_constructor", "risk_cap_toString", "risk_cap_"]) {
      expect(copyOrderPresentation({ status: "rejected", reason, filledSize: 0 }, t).reason, reason).toBe(unknown);
    }
    expect(copyOrderPresentation({ status: "rejected", reason: "exchange_said_no", filledSize: 0 }, t).status).toBe(zhTW.portfolio.copy.order.statusName.rejected);
    expect(copyOrderPresentation({ status: "filled", reason: "below_min_notional", filledSize: 1 }, t).reason).toBeNull();
  });
});

describe("copy order size", () => {
  it("shows no size for a refusal whose planned size rounded to 0, and the filled part of a partial fill", () => {
    expect(copyOrderPresentation({ status: "rejected", reason: "below_min_notional", filledSize: 0, size: 0 }, t).size).toBeNull();
    expect(copyOrderPresentation({ status: "rejected", reason: "below_min_notional", filledSize: 0, size: 0.1 }, t).size).toBe(0.1);
    expect(copyOrderPresentation({ status: "cancelled", reason: "stale_signal_before_fill", filledSize: 0.4, size: 1 }, t).size).toBe(0.4);
  });
});
