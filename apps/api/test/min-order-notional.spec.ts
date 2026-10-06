import { describe, expect, it } from "vitest";
import { DEFAULT_COPY_RISK_LIMITS, type CopyStrategySettings } from "@trading-dashboard/shared/contracts";

import { d } from "../src/common/decimal/dec.js";
import { evaluateRisk } from "../src/copy/copy-risk.js";
import { minOrderNotional } from "../src/copy/min-order-notional.js";
import { assessLiveAccountRisk, type LiveAccountRiskInput } from "../src/copy/live/live-account-risk.js";
import { buildOrderAction, type LiveOrderIntent } from "../src/copy/live/live-order.js";
import { fixture, reservation } from "./copy-live-risk-test-utils.js";

const settings: CopyStrategySettings = { direction: "same", sizingMode: "ratio", perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: null, copyStartMode: "delta" };
const off = { pauseNewRisk: false, reduceOnly: false };
/** The paper risk's decision for one open of `notional` at a price of 100. */
function paper(minOrderNotionalUsd: number, notional: number) {
  return evaluateRisk({ limits: { ...DEFAULT_COPY_RISK_LIMITS, minOrderNotionalUsd }, settings, controls: { platform: off, user: off, strategy: off }, coin: "BTC",
    increasesRisk: true, signalAgeSeconds: 1, coinMaxLeverage: 40, notional: d(notional), px: d(100), signalPx: d(100),
    strategy: { allocated: d(1_000), equity: d(1_000), exposure: d(0), reservedMargin: d(0), reservedNotional: d(0), ordersLastMinute: 0 },
    user: { coinExposure: d(0), exposure: d(0) } });
}
/** The live risk gate's decision for one open of `notional` at the fixture's price of 100. */
function live(minOrderNotionalUsd: number, notional: number) {
  const value = structuredClone(fixture()) as LiveAccountRiskInput & { intent: LiveOrderIntent; policy: { limits: { minOrderNotionalUsd: number } } };
  const mutable = value as unknown as { intent: LiveOrderIntent; action: unknown; reservations: { own: unknown }; policy: { limits: { minOrderNotionalUsd: number } } };
  Object.assign(mutable.intent, { size: String(notional / 100) });
  mutable.action = buildOrderAction(mutable.intent); mutable.reservations.own = reservation(mutable.intent);
  mutable.policy.limits.minOrderNotionalUsd = minOrderNotionalUsd;
  return assessLiveAccountRisk(value);
}

describe("one minimum order value for every copy, paper and live", () => {
  it("is the policy's minimum, never below the exchange's 10", () => {
    expect(minOrderNotional({ minOrderNotionalUsd: 0 }).toString()).toBe("10");
    expect(minOrderNotional({ minOrderNotionalUsd: 5 }).toString()).toBe("10");
    expect(minOrderNotional({ minOrderNotionalUsd: 12.5 }).toString()).toBe("12.5");
  });

  it("paper and live refuse exactly the same opens", () => {
    for (const [minimum, notional] of [[0, 8], [5, 8], [5, 11], [12, 11], [12, 13], [10, 10]] as const) {
      const allowed = d(notional).gte(minOrderNotional({ minOrderNotionalUsd: minimum }));
      const paperDecision = paper(minimum, notional), liveDecision = live(minimum, notional);
      expect({ minimum, notional, paper: paperDecision.ok }).toEqual({ minimum, notional, paper: allowed });
      expect({ minimum, notional, live: liveDecision.ok }).toEqual({ minimum, notional, live: allowed });
      if (!allowed) {
        expect(paperDecision).toEqual({ ok: false, reason: "below_min_notional" });
        expect(liveDecision).toEqual({ ok: false, reason: "below_min_notional" });
      }
    }
  });
});
