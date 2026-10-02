import { describe, expect, it } from "vitest";
import { DEFAULT_COPY_RISK_LIMITS, adminCopyControlRequestSchema, coinKey, copyRiskLimitsSchema, createCopyStrategyRequestSchema, type CopyStrategySettings } from "@trading-dashboard/shared/contracts";

import { accountHealth } from "../src/copy/copy-execution.service.js";
import { AssetMap, hip3DexesOf, maintenanceMargin, type Mids } from "../src/copy/copy-market.service.js";
import { applyFill, cloidOf, dec, fillFees, floorSize, fundingHours, fundingPayment, legsOf, openNotional, reduceSize, reduceWithCarry, roundPx, slippedPx, tradeKeyOf, type LeaderFill } from "../src/copy/copy-math.js";
import { marketDataGap } from "../src/copy/copy-planner.service.js";
import { evaluateRisk, pricedCoins, symbolRefusal, type RiskInput } from "../src/copy/copy-risk.js";

const fill = (o: Partial<LeaderFill>): LeaderFill => ({ tid: 1n, coin: "BTC", px: 100, sz: 1, side: "B", time: 1, startPosition: 0, tradeKey: "oid:1", ...o });

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

describe("review round 4, the copy engine's remaining rules", () => {
  it("funding: one payment per hour boundary held across, the first one included (38)", () => {
    const at = (iso: string) => new Date(`2026-10-02T${iso}Z`);
    expect(fundingHours(at("10:30:00"), at("11:00:00"))).toBe(1);
    expect(fundingHours(at("10:59:59.999"), at("11:00:00"))).toBe(1);
    expect(fundingHours(at("10:30:00"), at("13:00:00"))).toBe(3);
    // Accrued through 11:00 (or opened exactly then): nothing more at 11:00, one at 12:00.
    expect(fundingHours(at("11:00:00"), at("11:00:00"))).toBe(0);
    expect(fundingHours(at("11:00:00"), at("12:00:00"))).toBe(1);
    expect(fundingHours(at("12:00:00"), at("11:00:00"))).toBe(0);
  });

  it("adoption has no signal age and no per-minute cap, and keeps every other cap (39)", () => {
    const late = { signalAgeSeconds: 3_600, strategy: { ...risk().strategy, ordersLastMinute: 500 } };
    expect(evaluateRisk(risk(late))).toEqual({ ok: false, reason: "stale_signal" });
    expect(evaluateRisk(risk({ ...late, signalAgeSeconds: 1 }))).toEqual({ ok: false, reason: "frequency" });
    expect(evaluateRisk(risk({ ...late, adoption: true, signalPx: null }))).toMatchObject({ ok: true });
    // Still stopped by a pause, a blocked coin and the exposure caps.
    expect(evaluateRisk(risk({ ...late, adoption: true, controls: { ...risk().controls, user: { pauseNewRisk: true, reduceOnly: false } } }))).toEqual({ ok: false, reason: "user_paused" });
    expect(evaluateRisk(risk({ ...late, adoption: true, limits: { ...DEFAULT_COPY_RISK_LIMITS, blockedCoins: ["BTC"] } }))).toEqual({ ok: false, reason: "symbol_blocked" });
    expect(evaluateRisk(risk({ ...late, adoption: true, user: { coinExposure: 0, exposure: DEFAULT_COPY_RISK_LIMITS.maxUserExposureUsd } }))).toMatchObject({ ok: false, reason: "below_min_after_max_user_exposure" });
  });

  it("the unit of fixed sizing is the leader's trade: one order id, or one TWAP (40)", () => {
    expect(tradeKeyOf({ oid: 77 })).toBe("oid:77");
    expect(tradeKeyOf({ oid: 77, twapId: null })).toBe("oid:77");
    expect(tradeKeyOf({ oid: 77, twapId: 9 })).toBe("twap:9");
    expect(tradeKeyOf({ oid: 78, twapId: 9 })).toBe("twap:9");
    expect(legsOf(fill({ tradeKey: "twap:9" }))![0]!.tradeKey).toBe("twap:9");
    const flip = legsOf(fill({ startPosition: 2, side: "A", sz: 3, tradeKey: "oid:5" }))!;
    expect(flip.map((l) => l.tradeKey)).toEqual(["oid:5", "oid:5"]);
  });

  it("Hyperliquid's maintenance margin is half the initial margin at the coin's max leverage (41)", () => {
    expect(maintenanceMargin(10_000, 40)).toBe(125);
    expect(maintenanceMargin(-10_000, 20)).toBe(250);
    expect(maintenanceMargin(10_000, 3)).toBeCloseTo(1_666.6667, 3);
    const mids: Mids = { at: new Date(), px: new Map([["BTC", 81_000], ["ETH", 3_000]]), missingDexes: new Set() };
    const assets = new AssetMap([["BTC", { szDecimals: 5, maxLeverage: 40, funding: 0, markPx: 81_000 }], ["ETH", { szDecimals: 4, maxLeverage: 25, funding: 0, markPx: 3_000 }]]);
    // Long 0.05 BTC from 100,050 with 997.75 cash: equity 45.25 against 50.625 required.
    expect(accountHealth(997.75, [{ coin: "BTC", size: "0.05", entryPx: "100050" }], mids, assets)).toEqual({ equity: expect.closeTo(45.25, 8), maintenance: 50.625 });
    // A short that gains is part of the same account.
    const hedged = accountHealth(997.75, [{ coin: "BTC", size: "0.05", entryPx: "100050" }, { coin: "ETH", size: "-1", entryPx: "4000" }], mids, assets)!;
    expect(hedged.equity).toBeCloseTo(1_045.25, 8);
    expect(hedged.maintenance).toBeCloseTo(50.625 + 60, 8);
    // No price or no universe entry: not valued, never liquidated on a guess.
    expect(accountHealth(1_000, [{ coin: "SOL", size: "1", entryPx: "200" }], mids, assets)).toBeNull();
    expect(accountHealth(1_000, [], mids, assets)).toEqual({ equity: 1_000, maintenance: 0 });
  });

  it("a reduction below one lot is carried into the next one (42)", () => {
    // 0.1 % of 0.05 ETH is half a lot (4 decimals).
    expect(reduceWithCarry(0.05, 0.001, 0, 4)).toEqual({ size: 0, carry: expect.closeTo(0.00005, 12) });
    const second = reduceWithCarry(0.05, 0.001, 0.00005, 4);
    expect(second.size).toBe(0);
    expect(second.carry).toBeCloseTo(0.00009995, 12);
    const third = reduceWithCarry(0.05, 0.001, second.carry, 4);
    expect(third.size).toBe(0.0001);
    expect(third.carry).toBeCloseTo(0.00004985, 10);
    // A full close takes everything and owes nothing.
    expect(reduceWithCarry(0.0499, 1, third.carry, 4)).toEqual({ size: 0.0499, carry: 0 });
    // Without the lot size nothing is rounded.
    expect(reduceWithCarry(0.05, 0.001, 0, null)).toEqual({ size: expect.closeTo(0.00005, 12), carry: 0 });
    expect(reduceWithCarry(0, 0.5, 0, 4)).toEqual({ size: 0, carry: 0 });
  });

  it("twenty 1 % trims leave the follower within one lot of the leader's fraction, whatever the lot size (42)", () => {
    for (const [start, szDecimals] of [[0.05, 4], [0.00123, 5], [137, 0], [2.5, 1]] as const) {
      let size: number = start;
      let carry = 0;
      for (let i = 0; i < 20; i++) {
        const r = reduceWithCarry(size, 0.01, carry, szDecimals);
        size = Number((size - r.size).toFixed(8));
        carry = r.carry;
      }
      const lot = 10 ** -szDecimals;
      expect(Math.abs(size - carry - start * 0.99 ** 20)).toBeLessThan(1e-7);
      expect(carry).toBeLessThan(lot);
      // Rounding each trim down on its own would have moved nothing for these sizes.
      if (floorSize(start * 0.01, szDecimals) === 0) expect(size).toBeLessThan(start);
    }
  });

  it("a builder-dex market: refused without data while the policy does not copy it, a gap while its dex can't be read (42)", () => {
    const off = DEFAULT_COPY_RISK_LIMITS;
    const on = { ...off, allowHip3: true };
    expect(symbolRefusal(off, "xyz:TSLA")).toBe("symbol_not_allowed");
    expect(symbolRefusal(on, "xyz:TSLA")).toBeNull();
    expect(symbolRefusal({ ...on, blockedCoins: ["XYZ:tsla"] }, "xyz:TSLA")).toBe("symbol_blocked");
    expect(pricedCoins(off, ["BTC", "xyz:TSLA", "BTC"])).toEqual(["BTC"]);
    expect(pricedCoins(on, ["BTC", "xyz:TSLA"])).toEqual(["BTC", "xyz:TSLA"]);
    expect(hip3DexesOf(["BTC", "xyz:TSLA", "flx:GOLD", "xyz:NVDA"])).toEqual(["flx", "xyz"]);

    const mids = (missing: string[] = []): Mids => ({ at: new Date(), px: new Map(), missingDexes: new Set(missing) });
    const assets = (missing: string[] = []) => { const a = new AssetMap(); for (const d of missing) a.missingDexes.add(d); return a; };
    expect(marketDataGap(null, assets(), "xyz:TSLA")).toBe("mids");
    expect(marketDataGap(mids(["xyz"]), assets(), "xyz:TSLA")).toBe("mids");
    expect(marketDataGap(mids(), assets(["xyz"]), "xyz:TSLA")).toBe("asset_info");
    expect(marketDataGap(mids(), null, "xyz:TSLA")).toBe("asset_info");
    expect(marketDataGap(mids(), assets(), "xyz:TSLA")).toBeNull();
    // One dex being down is not a gap for the others.
    expect(marketDataGap(mids(["xyz"]), assets(["xyz"]), "BTC")).toBeNull();
    expect(marketDataGap(mids(["xyz"]), assets(["xyz"]), "flx:GOLD")).toBeNull();
  });
});
