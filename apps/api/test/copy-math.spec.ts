import { describe, expect, it } from "vitest";
import { DEFAULT_COPY_RISK_LIMITS, adminCopyControlRequestSchema, coinKey, copyRiskLimitsSchema, createCopyStrategyRequestSchema, type CopyStrategySettings } from "@trading-dashboard/shared/contracts";

import { applyFill, cloidOf, dec, fillFees, floorSize, fundingPayment, legsOf, openNotional, reduceSize, roundPx, slippedPx, type LeaderFill } from "../src/copy/copy-math.js";
import { evaluateRisk, type RiskInput } from "../src/copy/copy-risk.js";

const fill = (o: Partial<LeaderFill>): LeaderFill => ({ tid: 1n, coin: "BTC", px: 100, sz: 1, side: "B", time: 1, startPosition: 0, ...o });

describe("canonical legs of a verified fill", () => {
  it("opens, adds, reduces and closes from the fill's own startPosition", () => {
    expect(legsOf(fill({ startPosition: 0, side: "B", sz: 2 }))).toMatchObject([{ leg: "open", sign: 1, size: 2 }]);
    expect(legsOf(fill({ startPosition: 2, side: "B", sz: 1 }))).toMatchObject([{ leg: "open", sign: 1, size: 1 }]);
    expect(legsOf(fill({ startPosition: -2, side: "A", sz: 1 }))).toMatchObject([{ leg: "open", sign: -1, size: 1 }]);
    expect(legsOf(fill({ startPosition: 4, side: "A", sz: 1 }))).toMatchObject([{ leg: "close", sign: 1, size: 1, fraction: 0.25 }]);
    expect(legsOf(fill({ startPosition: 4, side: "A", sz: 4 }))).toMatchObject([{ leg: "close", sign: 1, fraction: 1 }]);
    expect(legsOf(fill({ startPosition: -3, side: "B", sz: 3 }))).toMatchObject([{ leg: "close", sign: -1, fraction: 1 }]);
  });

  it("splits a flip into a full close of the old side and an open of the new", () => {
    const legs = legsOf(fill({ startPosition: 1, side: "A", sz: 3 }));
    expect(legs).toHaveLength(2);
    expect(legs![0]).toMatchObject({ leg: "close", sign: 1, size: 1, fraction: 1 });
    expect(legs![1]).toMatchObject({ leg: "open", sign: -1, size: 2 });
  });

  it("refuses to guess without a startPosition", () => {
    expect(legsOf(fill({ startPosition: null }))).toBeNull();
  });
});

describe("sizing and exchange rounding", () => {
  it("ratio: leader notional × strategy equity ÷ leader equity; unknown leader equity is null, never 0", () => {
    expect(openNotional({ mode: "ratio", perTradeUsd: null, leaderNotional: 50_000, strategyEquity: 1_000, leaderEquity: 10_000 })).toBe(5_000);
    expect(openNotional({ mode: "ratio", perTradeUsd: null, leaderNotional: 50_000, strategyEquity: 1_000, leaderEquity: null })).toBeNull();
    expect(openNotional({ mode: "ratio", perTradeUsd: null, leaderNotional: 50_000, strategyEquity: 1_000, leaderEquity: 0 })).toBeNull();
    expect(openNotional({ mode: "fixed", perTradeUsd: 250, leaderNotional: 50_000, strategyEquity: 1_000, leaderEquity: null })).toBe(250);
  });

  it("reduces by the leader's fraction of the follower's own position", () => {
    expect(reduceSize(0.8, 0.25)).toBeCloseTo(0.2);
    expect(reduceSize(0.8, 1)).toBe(0.8);
    expect(reduceSize(0, 0.5)).toBe(0);
  });

  it("floors sizes to szDecimals and prices to 5 significant figures / 6 − szDecimals decimals", () => {
    expect(floorSize(0.0512345, 5)).toBe(0.05123);
    expect(floorSize(12.9, 0)).toBe(12);
    expect(roundPx(100050, 5)).toBe(100050);
    expect(roundPx(1.234567, 1)).toBe(1.2346);
    expect(roundPx(0.0123456, 0)).toBe(0.012346);
    expect(roundPx(3.14159, 4)).toBe(3.14);
    expect(dec(-0.000000001)).toBe("0");
    expect(dec(1488.97513750)).toBe("1488.9751375");
  });

  it("client order ids are deterministic 16-byte hex", () => {
    expect(cloidOf("1:42:open:v1")).toBe(cloidOf("1:42:open:v1"));
    expect(cloidOf("1:42:open:v1")).not.toBe(cloidOf("1:42:open:v2"));
    expect(cloidOf("x")).toMatch(/^0x[0-9a-f]{32}$/);
  });
});

describe("paper ledger — hand-computed fixture", () => {
  it("open, add, partial close and full close with fees", () => {
    // Buy 0.05 @ 100,050 (mid 100,000 + 5 bps).
    let pos = { size: 0, entryPx: 0 };
    const px1 = slippedPx(100_000, "B", 5);
    expect(px1).toBeCloseTo(100_050);
    let r = applyFill(pos, 1, 0.05, px1);
    expect(r).toEqual({ size: 0.05, entryPx: px1, realizedPnl: 0 });
    pos = r;
    // Add 0.05 @ 102,000 → entry = (0.05·100,050 + 0.05·102,000) / 0.1 = 101,025.
    r = applyFill(pos, 1, 0.05, 102_000);
    expect(r.size).toBeCloseTo(0.1);
    expect(r.entryPx).toBeCloseTo(101_025);
    pos = r;
    // Sell 0.04 @ 109,945 → realized 0.04 × (109,945 − 101,025) = 356.8.
    r = applyFill(pos, -1, 0.04, 109_945);
    expect(r.realizedPnl).toBeCloseTo(356.8);
    expect(r.size).toBeCloseTo(0.06);
    expect(r.entryPx).toBeCloseTo(101_025);
    pos = r;
    // Sell the rest 0.06 @ 99,000 → realized 0.06 × (99,000 − 101,025) = −121.5; flat.
    r = applyFill(pos, -1, 0.06, 99_000);
    expect(r.realizedPnl).toBeCloseTo(-121.5);
    expect(r).toMatchObject({ size: 0, entryPx: 0 });
    // Fees: 4.5 bps taker + 10 tenths-bps (1 bps) builder on 5,002.50 notional.
    const f = fillFees(0.05 * 100_050, 4.5, 10);
    expect(f.fee).toBeCloseTo(2.251125);
    expect(f.builderFee).toBeCloseTo(0.50025);
    // Funding: long 0.05 at mark 100,000, +0.01%/h for 2 h = 1.0 paid.
    expect(fundingPayment(0.05, 100_000, 0.0001) * 2).toBeCloseTo(1);
    expect(fundingPayment(-0.05, 100_000, 0.0001)).toBeCloseTo(-0.5);
  });

  it("a short realizes profit when price falls", () => {
    const r = applyFill({ size: -2, entryPx: 50 }, 1, 2, 40);
    expect(r).toMatchObject({ size: 0, realizedPnl: 20 });
  });
});

const settings: CopyStrategySettings = { direction: "same", sizingMode: "ratio", perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: null, copyStartMode: "delta" };
const off = { pauseNewRisk: false, reduceOnly: false };
function risk(o: Partial<RiskInput> = {}): RiskInput {
  return {
    limits: DEFAULT_COPY_RISK_LIMITS, settings, controls: { platform: off, user: off, strategy: off }, coin: "BTC", increasesRisk: true,
    notional: 1_000, px: 100, signalPx: 100, signalAgeSeconds: 1, coinMaxLeverage: 40,
    strategy: { allocated: 1_000, equity: 1_000, exposure: 0, reservedMargin: 0, reservedNotional: 0, ordersLastMinute: 0 },
    user: { coinExposure: 0, exposure: 0 }, ...o,
  };
}

describe("layered risk", () => {
  it("approves within every cap", () => {
    expect(evaluateRisk(risk())).toMatchObject({ ok: true, notional: 1_000, margin: 100, leverage: 10 });
  });

  it("refuses new risk under any pause or reduce-only, widest scope first", () => {
    expect(evaluateRisk(risk({ controls: { platform: { pauseNewRisk: true, reduceOnly: false }, user: off, strategy: off } }))).toEqual({ ok: false, reason: "platform_paused" });
    expect(evaluateRisk(risk({ controls: { platform: off, user: { pauseNewRisk: false, reduceOnly: true }, strategy: off } }))).toEqual({ ok: false, reason: "user_reduce_only" });
    expect(evaluateRisk(risk({ controls: { platform: off, user: off, strategy: { pauseNewRisk: true, reduceOnly: false } } }))).toEqual({ ok: false, reason: "strategy_paused" });
  });

  it("never refuses a reduction, whatever the controls or caps", () => {
    const d = evaluateRisk(risk({ increasesRisk: false, controls: { platform: { pauseNewRisk: true, reduceOnly: true }, user: off, strategy: off }, signalAgeSeconds: 99_999 }));
    expect(d.ok).toBe(true);
  });

  it("symbol, dex, age, price, frequency", () => {
    const limits = copyRiskLimitsSchema.parse({ blockedCoins: ["kpepe", " btc "] });
    expect(evaluateRisk(risk({ limits, coin: "kPEPE" }))).toEqual({ ok: false, reason: "symbol_blocked" });
    expect(evaluateRisk(risk({ limits, coin: "BTC" }))).toEqual({ ok: false, reason: "symbol_blocked" });
    expect(evaluateRisk(risk({ coin: "xyz:TSLA" }))).toEqual({ ok: false, reason: "symbol_not_allowed" });
    expect(evaluateRisk(risk({ signalAgeSeconds: 121 }))).toEqual({ ok: false, reason: "stale_signal" });
    expect(evaluateRisk(risk({ px: 100.6, signalPx: 100 }))).toEqual({ ok: false, reason: "price_moved" });
    expect(evaluateRisk(risk({ strategy: { ...risk().strategy, ordersLastMinute: 30 } }))).toEqual({ ok: false, reason: "frequency" });
  });

  it("clamps to per-order, per-coin, per-user, strategy and available-funds caps", () => {
    expect(evaluateRisk(risk({ notional: 9_000 }))).toMatchObject({ ok: true, notional: 5_000, notes: ["max_strategy_exposure"] });
    const limits = { ...DEFAULT_COPY_RISK_LIMITS, maxOrderNotionalUsd: 600 };
    expect(evaluateRisk(risk({ limits }))).toMatchObject({ ok: true, notional: 600, notes: ["max_order"] });
    expect(evaluateRisk(risk({ user: { coinExposure: 99_700, exposure: 99_700 } }))).toMatchObject({ ok: true, notional: 300, notes: ["max_coin_exposure"] });
    // Available funds: 1,000 equity − (4,000 / 10 + 550) margin = 50 → 500 notional at 10×.
    expect(evaluateRisk(risk({ strategy: { ...risk().strategy, exposure: 4_000, reservedMargin: 550 } }))).toMatchObject({ ok: true, notional: 500, notes: ["available_funds"] });
    expect(evaluateRisk(risk({ strategy: { ...risk().strategy, equity: 50, exposure: 0 } }))).toMatchObject({ ok: true, notional: 500, notes: ["max_strategy_exposure"] });
    expect(evaluateRisk(risk({ strategy: { ...risk().strategy, equity: 0.5 } }))).toEqual({ ok: false, reason: "below_min_after_max_strategy_exposure" });
    expect(evaluateRisk(risk({ notional: 5 }))).toEqual({ ok: false, reason: "below_min_notional" });
  });

  it("leverage is the lowest of strategy, platform and exchange", () => {
    expect(evaluateRisk(risk({ settings: { ...settings, maxLeverage: 3 } }))).toMatchObject({ leverage: 3 });
    expect(evaluateRisk(risk({ coinMaxLeverage: 5 }))).toMatchObject({ leverage: 5 });
  });
});

describe("contract normalization (security review)", () => {
  it("lower-cases the leader and keeps amounts to 6 decimals", () => {
    const req = createCopyStrategyRequestSchema.parse({ leader: "0xAbCdEf0000000000000000000000000000000001", allocationUsd: 150 });
    expect(req.leader).toBe("0xabcdef0000000000000000000000000000000001");
    expect(req).toMatchObject({ direction: "same", sizingMode: "ratio", copyStartMode: "adopt", maxLeverage: null, maxTotalExposureUsd: null });
    expect(createCopyStrategyRequestSchema.safeParse({ leader: "0x" + "a".repeat(40), allocationUsd: 1.0000001 }).success).toBe(false);
  });

  it("the admin control target is a discriminated union", () => {
    const base = { command: "pause_new_risk", reason: "incident", expectedRevision: 0 };
    expect(adminCopyControlRequestSchema.safeParse({ ...base, scope: "platform" }).success).toBe(true);
    expect(adminCopyControlRequestSchema.safeParse({ ...base, scope: "platform", userId: 5 }).success).toBe(false);
    expect(adminCopyControlRequestSchema.safeParse({ ...base, scope: "user" }).success).toBe(false);
    expect(adminCopyControlRequestSchema.safeParse({ ...base, scope: "user", userId: null }).success).toBe(false);
    expect(adminCopyControlRequestSchema.safeParse({ ...base, scope: "user", userId: 5 }).success).toBe(true);
  });

  it("rejects impossible policies and matches coins case-insensitively", () => {
    expect(copyRiskLimitsSchema.safeParse({ minAllocationUsd: 500, maxAllocationUsd: 100 }).success).toBe(false);
    expect(copyRiskLimitsSchema.safeParse({ minOrderNotionalUsd: 60_000 }).success).toBe(false);
    expect(copyRiskLimitsSchema.safeParse({ blockedCoins: ["BTC;DROP"] }).success).toBe(false);
    expect(copyRiskLimitsSchema.parse({ blockedCoins: ["kPEPE", "KPEPE", "kpepe"] }).blockedCoins).toEqual(["kpepe"]);
    expect(coinKey(" xyz:TSLA ")).toBe(coinKey("XYZ:tsla"));
  });
});
