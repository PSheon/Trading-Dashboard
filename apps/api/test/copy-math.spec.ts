import { describe, expect, it } from "vitest";
import { DEFAULT_COPY_RISK_LIMITS, adminCopyControlRequestSchema, coinKey, copyRiskLimitsSchema, createCopyStrategyRequestSchema, type CopyStrategySettings } from "@trading-dashboard/shared/contracts";

import { Dec, d } from "../src/common/decimal/dec.js";
import { accountHealth } from "../src/copy/copy-execution.service.js";
import { AssetMap, hip3DexesOf, maintenanceMargin, type Mids } from "../src/copy/copy-market.service.js";
import { applyFill, cloidOf, dec, fillFees, floorSize, fundingHours, fundingPayment, legsOf, openNotional, reduceSize, reduceWithCarry, roundPx, slippedPx, tradeKeyOf, type LeaderFill } from "../src/copy/copy-math.js";
import { marketDataGap } from "../src/copy/copy-planner.service.js";
import { evaluateRisk, pricedCoins, symbolRefusal, type RiskInput } from "../src/copy/copy-risk.js";

type FillInput = Partial<Omit<LeaderFill, "px" | "sz" | "startPosition">> & { px?: number | string; sz?: number | string; startPosition?: number | string | null };
const fill = (o: FillInput): LeaderFill => ({
  tid: 1n, coin: "BTC", side: "B", time: 1, tradeKey: "oid:1", ...o,
  px: d(o.px ?? 100), sz: d(o.sz ?? 1), startPosition: o.startPosition === null ? null : d(o.startPosition ?? 0),
});

describe("canonical legs of a verified fill", () => {
  it("opens, adds, reduces and closes from the fill's own startPosition", () => {
    expect(legsOf(fill({ startPosition: 0, side: "B", sz: 2 }))).toMatchObject([{ leg: "open", sign: 1, size: d(2) }]);
    expect(legsOf(fill({ startPosition: 2, side: "B", sz: 1 }))).toMatchObject([{ leg: "open", sign: 1, size: d(1) }]);
    expect(legsOf(fill({ startPosition: -2, side: "A", sz: 1 }))).toMatchObject([{ leg: "open", sign: -1, size: d(1) }]);
    expect(legsOf(fill({ startPosition: 4, side: "A", sz: 1 }))).toMatchObject([{ leg: "close", sign: 1, size: d(1), fraction: d("0.25") }]);
    expect(legsOf(fill({ startPosition: 4, side: "A", sz: 4 }))).toMatchObject([{ leg: "close", sign: 1, fraction: d(1) }]);
    expect(legsOf(fill({ startPosition: -3, side: "B", sz: 3 }))).toMatchObject([{ leg: "close", sign: -1, fraction: d(1) }]);
  });

  it("classifies from Hyperliquid's strings exactly: 0.3 − 0.1 − 0.2 is flat, not a position of 5.5e-17", () => {
    // As floats 0.3 − 0.1 − 0.2 leaves a dust position and would read as a reduction.
    expect(0.3 - 0.1 - 0.2).not.toBe(0);
    expect(legsOf(fill({ startPosition: "0.2", side: "A", sz: "0.2" }))).toMatchObject([{ leg: "close", fraction: d(1) }]);
    expect(legsOf(fill({ startPosition: "0.3", side: "A", sz: "0.1" }))![0]).toMatchObject({ leg: "close", size: d("0.1") });
    expect(legsOf(fill({ startPosition: "-0.00001", side: "B", sz: "0.00003" }))).toMatchObject([{ leg: "close", fraction: d(1), size: d("0.00001") }, { leg: "open", sign: 1, size: d("0.00002") }]);
    expect(legsOf(fill({ sz: 0 }))).toEqual([]);
  });

  it("splits a flip into a full close of the old side and an open of the new", () => {
    const legs = legsOf(fill({ startPosition: 1, side: "A", sz: 3 }));
    expect(legs).toHaveLength(2);
    expect(legs![0]).toMatchObject({ leg: "close", sign: 1, size: d(1), fraction: d(1) });
    expect(legs![1]).toMatchObject({ leg: "open", sign: -1, size: d(2) });
  });

  it("refuses to guess without a startPosition", () => {
    expect(legsOf(fill({ startPosition: null }))).toBeNull();
  });
});

describe("sizing and exchange rounding", () => {
  it("ratio: leader notional × strategy equity ÷ leader equity; unknown leader equity is null, never 0", () => {
    const ratio = (leaderEquity: Dec | null) => openNotional({ mode: "ratio", perTradeUsd: null, leaderNotional: d(50_000), strategyEquity: d(1_000), leaderEquity });
    expect(ratio(d(10_000))?.toString()).toBe("5000");
    expect(ratio(null)).toBeNull();
    expect(ratio(d(0))).toBeNull();
    expect(openNotional({ mode: "fixed", perTradeUsd: 250, leaderNotional: d(50_000), strategyEquity: d(1_000), leaderEquity: null })?.toString()).toBe("250");
  });

  it("reduces by the leader's fraction of the follower's own position", () => {
    expect(reduceSize(d("0.8"), d("0.25")).toString()).toBe("0.2");
    expect(reduceSize(d("0.8"), d(1)).toString()).toBe("0.8");
    expect(reduceSize(d(0), d("0.5")).toString()).toBe("0");
  });

  it("floors sizes to szDecimals and prices to 5 significant figures / 6 − szDecimals decimals", () => {
    expect(floorSize(d("0.0512345"), 5).toString()).toBe("0.05123");
    expect(floorSize(d("12.9"), 0).toString()).toBe("12");
    // Exactly on a lot: a float multiply-and-floor could lose it (0.29 × 100 is 28.999…).
    expect(floorSize(d("0.29"), 2).toString()).toBe("0.29");
    expect(floorSize(d("-1"), 2).toString()).toBe("0");
    expect(roundPx(d(100050), 5).toString()).toBe("100050");
    expect(roundPx(d("1.234567"), 1).toString()).toBe("1.2346");
    expect(roundPx(d("0.0123456"), 0).toString()).toBe("0.012346");
    expect(roundPx(d("3.14159"), 4).toString()).toBe("3.14");
    expect(dec(-0.000000001)).toBe("0");
    expect(dec("1488.97513750")).toBe("1488.9751375");
    expect(dec(d("0.123456789"), 2)).toBe("0.12");
  });

  it("client order ids are deterministic 16-byte hex", () => {
    expect(cloidOf("1:42:open:v1")).toBe(cloidOf("1:42:open:v1"));
    expect(cloidOf("1:42:open:v1")).not.toBe(cloidOf("1:42:open:v2"));
    expect(cloidOf("x")).toMatch(/^0x[0-9a-f]{32}$/);
  });
});

describe("paper ledger — hand-computed fixture, to the last digit", () => {
  it("open, add, partial close and full close with fees", () => {
    // Buy 0.05 @ 100,050 (mid 100,000 + 5 bps).
    const px1 = slippedPx(d(100_000), "B", 5);
    expect(px1.toString()).toBe("100050");
    let r = applyFill({ size: d(0), entryPx: d(0) }, 1, d("0.05"), px1);
    expect([r.size, r.entryPx, r.realizedPnl].map(String)).toEqual(["0.05", "100050", "0"]);
    // Add 0.05 @ 102,000 → entry = (0.05·100,050 + 0.05·102,000) / 0.1 = 101,025.
    r = applyFill(r, 1, d("0.05"), d(102_000));
    expect([r.size, r.entryPx].map(String)).toEqual(["0.1", "101025"]);
    // Sell 0.04 @ 109,945 → realized 0.04 × (109,945 − 101,025) = 356.8.
    r = applyFill(r, -1, d("0.04"), d(109_945));
    expect([r.size, r.entryPx, r.realizedPnl].map(String)).toEqual(["0.06", "101025", "356.8"]);
    // Sell the rest 0.06 @ 99,000 → realized 0.06 × (99,000 − 101,025) = −121.5; flat.
    r = applyFill(r, -1, d("0.06"), d(99_000));
    expect([r.size, r.entryPx, r.realizedPnl].map(String)).toEqual(["0", "0", "-121.5"]);
    // Fees: 4.5 bps taker + 10 tenths-bps (1 bps) builder on 5,002.50 notional.
    const f = fillFees(d("0.05").mul(100_050), 4.5, 10);
    expect([f.fee, f.builderFee].map(String)).toEqual(["2.251125", "0.50025"]);
    // Funding: long 0.05 at mark 100,000, +0.01%/h for 2 h = 1.0 paid.
    expect(fundingPayment(d("0.05"), d(100_000), d("0.0001"), 2).toString()).toBe("1");
    expect(fundingPayment(d("-0.05"), d(100_000), d("0.0001")).toString()).toBe("-0.5");
  });

  it("a short realizes profit when price falls", () => {
    const r = applyFill({ size: d(-2), entryPx: d(50) }, 1, d(2), d(40));
    expect([r.size, r.realizedPnl].map(String)).toEqual(["0", "20"]);
  });

  it("every USDC amount is quantized once, to 8 decimals", () => {
    // 0.00007 × 43,217.3 × 4.5 bps = 0.0013613449…
    const f = fillFees(d("0.00007").mul("43217.3"), 4.5, 1);
    expect(f.fee.toString()).toBe("0.00136134");
    expect(f.builderFee.toString()).toBe("0.00003025");
    // An entry price that does not terminate keeps 10 decimals.
    const r = applyFill({ size: d("0.3"), entryPx: d(100) }, 1, d("0.4"), d(101));
    expect(r.entryPx.toString()).toBe("100.5714285714");
    expect(applyFill(r, -1, d("0.7"), d("100.5714285714")).realizedPnl.toString()).toBe("0");
  });
});

const settings: CopyStrategySettings = { direction: "same", sizingMode: "ratio", perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: null, copyStartMode: "delta" };
const off = { pauseNewRisk: false, reduceOnly: false };
type Money = number | string;
interface RiskOverrides extends Partial<Omit<RiskInput, "notional" | "px" | "signalPx" | "strategy" | "user">> {
  notional?: Money; px?: Money; signalPx?: Money | null;
  strategy?: Partial<Record<"allocated" | "equity" | "exposure" | "reservedMargin" | "reservedNotional", Money>> & { ordersLastMinute?: number };
  user?: Partial<Record<"coinExposure" | "exposure", Money>>;
}
function risk(o: RiskOverrides = {}): RiskInput {
  const { notional, px, signalPx, strategy, user, ...rest } = o;
  return {
    limits: DEFAULT_COPY_RISK_LIMITS, settings, controls: { platform: off, user: off, strategy: off }, coin: "BTC", increasesRisk: true,
    signalAgeSeconds: 1, coinMaxLeverage: 40, ...rest,
    notional: d(notional ?? 1_000), px: d(px ?? 100), signalPx: signalPx === null ? null : d(signalPx ?? 100),
    strategy: {
      allocated: d(strategy?.allocated ?? 1_000), equity: d(strategy?.equity ?? 1_000), exposure: d(strategy?.exposure ?? 0),
      reservedMargin: d(strategy?.reservedMargin ?? 0), reservedNotional: d(strategy?.reservedNotional ?? 0), ordersLastMinute: strategy?.ordersLastMinute ?? 0,
    },
    user: { coinExposure: d(user?.coinExposure ?? 0), exposure: d(user?.exposure ?? 0) },
  };
}
/** A decision with its amounts as strings. */
const decide = (o: RiskOverrides = {}) => {
  const r = evaluateRisk(risk(o));
  return r.ok ? { ok: true, notional: r.notional.toString(), margin: r.margin.toString(), leverage: r.leverage, notes: r.notes } : r;
};

describe("layered risk", () => {
  it("approves within every cap", () => {
    expect(decide()).toMatchObject({ ok: true, notional: "1000", margin: "100", leverage: 10 });
  });

  it("refuses new risk under any pause or reduce-only, widest scope first", () => {
    expect(decide({ controls: { platform: { pauseNewRisk: true, reduceOnly: false }, user: off, strategy: off } })).toEqual({ ok: false, reason: "platform_paused" });
    expect(decide({ controls: { platform: off, user: { pauseNewRisk: false, reduceOnly: true }, strategy: off } })).toEqual({ ok: false, reason: "user_reduce_only" });
    expect(decide({ controls: { platform: off, user: off, strategy: { pauseNewRisk: true, reduceOnly: false } } })).toEqual({ ok: false, reason: "strategy_paused" });
  });

  it("never refuses a reduction, whatever the controls or caps", () => {
    expect(decide({ increasesRisk: false, controls: { platform: { pauseNewRisk: true, reduceOnly: true }, user: off, strategy: off }, signalAgeSeconds: 99_999 }).ok).toBe(true);
  });

  it("symbol, dex, age, price, frequency", () => {
    const limits = copyRiskLimitsSchema.parse({ blockedCoins: ["kpepe", " btc "] });
    expect(decide({ limits, coin: "kPEPE" })).toEqual({ ok: false, reason: "symbol_blocked" });
    expect(decide({ limits, coin: "BTC" })).toEqual({ ok: false, reason: "symbol_blocked" });
    expect(decide({ coin: "xyz:TSLA" })).toEqual({ ok: false, reason: "symbol_not_allowed" });
    expect(decide({ signalAgeSeconds: 121 })).toEqual({ ok: false, reason: "stale_signal" });
    expect(decide({ px: "100.6", signalPx: 100 })).toEqual({ ok: false, reason: "price_moved" });
    // Exactly at the limit (50 bps) is allowed: decided on the decimals, not on 49.99999999999….
    expect(decide({ px: "100.5", signalPx: 100 }).ok).toBe(true);
    expect(decide({ px: "100.50000001", signalPx: 100 })).toEqual({ ok: false, reason: "price_moved" });
    expect(decide({ strategy: { ordersLastMinute: 30 } })).toEqual({ ok: false, reason: "frequency" });
  });

  it("clamps to per-order, per-coin, per-user, strategy and available-funds caps", () => {
    expect(decide({ notional: 9_000 })).toMatchObject({ ok: true, notional: "5000", notes: ["max_strategy_exposure"] });
    const limits = { ...DEFAULT_COPY_RISK_LIMITS, maxOrderNotionalUsd: 600 };
    expect(decide({ limits })).toMatchObject({ ok: true, notional: "600", notes: ["max_order"] });
    expect(decide({ user: { coinExposure: 99_700, exposure: 99_700 } })).toMatchObject({ ok: true, notional: "300", notes: ["max_coin_exposure"] });
    // Available funds: 1,000 equity − (4,000 / 10 + 550) margin = 50 → 500 notional at 10×.
    expect(decide({ strategy: { exposure: 4_000, reservedMargin: 550 } })).toMatchObject({ ok: true, notional: "500", notes: ["available_funds"] });
    expect(decide({ strategy: { equity: 50, exposure: 0 } })).toMatchObject({ ok: true, notional: "500", notes: ["max_strategy_exposure"] });
    expect(decide({ strategy: { equity: "0.5" } })).toEqual({ ok: false, reason: "below_min_after_max_strategy_exposure" });
    expect(decide({ notional: 5 })).toEqual({ ok: false, reason: "below_min_notional" });
    // The minimum itself is allowed, one hundred-millionth under it is not.
    expect(decide({ notional: 10 }).ok).toBe(true);
    expect(decide({ notional: "9.99999999" })).toEqual({ ok: false, reason: "below_min_notional" });
  });

  it("leverage is the lowest of strategy, platform and exchange", () => {
    expect(decide({ settings: { ...settings, maxLeverage: 3 } })).toMatchObject({ leverage: 3 });
    expect(decide({ coinMaxLeverage: 5 })).toMatchObject({ leverage: 5 });
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
    const late = { signalAgeSeconds: 3_600, strategy: { ordersLastMinute: 500 } };
    expect(decide(late)).toEqual({ ok: false, reason: "stale_signal" });
    expect(decide({ ...late, signalAgeSeconds: 1 })).toEqual({ ok: false, reason: "frequency" });
    expect(decide({ ...late, adoption: true, signalPx: null })).toMatchObject({ ok: true });
    // Still stopped by a pause, a blocked coin and the exposure caps.
    expect(decide({ ...late, adoption: true, controls: { ...risk().controls, user: { pauseNewRisk: true, reduceOnly: false } } })).toEqual({ ok: false, reason: "user_paused" });
    expect(decide({ ...late, adoption: true, limits: { ...DEFAULT_COPY_RISK_LIMITS, blockedCoins: ["BTC"] } })).toEqual({ ok: false, reason: "symbol_blocked" });
    expect(decide({ ...late, adoption: true, user: { coinExposure: 0, exposure: DEFAULT_COPY_RISK_LIMITS.maxUserExposureUsd } })).toMatchObject({ ok: false, reason: "below_min_after_max_user_exposure" });
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
    expect(maintenanceMargin(d(10_000), 40).toString()).toBe("125");
    expect(maintenanceMargin(d(-10_000), 20).toString()).toBe("250");
    expect(maintenanceMargin(d(10_000), 3).round(4).toString()).toBe("1666.6667");
    const mids: Mids = { at: new Date(), px: new Map([["BTC", d(81_000)], ["ETH", d(3_000)]]), missingDexes: new Set() };
    const assets = new AssetMap([["BTC", { szDecimals: 5, maxLeverage: 40, funding: d(0), markPx: d(81_000) }], ["ETH", { szDecimals: 4, maxLeverage: 25, funding: d(0), markPx: d(3_000) }]]);
    const health = (cash: string, positions: { coin: string; size: string; entryPx: string }[]) => {
      const h = accountHealth(cash, positions, mids, assets);
      return h && { equity: h.equity.toString(), maintenance: h.maintenance.toString() };
    };
    // Long 0.05 BTC from 100,050 with 997.75 cash: equity 45.25 against 50.625 required.
    expect(health("997.75", [{ coin: "BTC", size: "0.05", entryPx: "100050" }])).toEqual({ equity: "45.25", maintenance: "50.625" });
    // A short that gains is part of the same account.
    expect(health("997.75", [{ coin: "BTC", size: "0.05", entryPx: "100050" }, { coin: "ETH", size: "-1", entryPx: "4000" }])).toEqual({ equity: "1045.25", maintenance: "110.625" });
    // No price or no universe entry: not valued, never liquidated on a guess.
    expect(health("1000", [{ coin: "SOL", size: "1", entryPx: "200" }])).toBeNull();
    expect(health("1000", [])).toEqual({ equity: "1000", maintenance: "0" });
  });

  it("a reduction below one lot is carried into the next one (42)", () => {
    // 0.1 % of 0.05 ETH is half a lot (4 decimals).
    const reduce = (size: string, fraction: string, carry: string, szDecimals: number | null) => {
      const r = reduceWithCarry(d(size), d(fraction), d(carry), szDecimals);
      return [r.size.toString(), r.carry.toString()];
    };
    expect(reduce("0.05", "0.001", "0", 4)).toEqual(["0", "0.00005"]);
    expect(reduce("0.05", "0.001", "0.00005", 4)).toEqual(["0", "0.00009995"]);
    expect(reduce("0.05", "0.001", "0.00009995", 4)).toEqual(["0.0001", "0.00004985005"]);
    // A full close takes everything and owes nothing.
    expect(reduce("0.0499", "1", "0.00004985005", 4)).toEqual(["0.0499", "0"]);
    // Without the lot size nothing is rounded.
    expect(reduce("0.05", "0.001", "0", null)).toEqual(["0.00005", "0"]);
    expect(reduce("0", "0.5", "0", 4)).toEqual(["0", "0"]);
  });

  it("twenty 1 % trims leave the follower within one lot of the leader's fraction, whatever the lot size (42)", () => {
    for (const [start, szDecimals] of [["0.05", 4], ["0.00123", 5], ["137", 0], ["2.5", 1]] as const) {
      let size = d(start);
      let carry = d(0);
      let target = d(start);
      for (let i = 0; i < 20; i++) {
        const r = reduceWithCarry(size, d("0.01"), carry, szDecimals);
        size = size.sub(r.size);
        carry = r.carry;
        target = target.mul("0.99");
      }
      // What is held less what is still owed is the leader's fraction, to the 16th decimal.
      expect(size.sub(carry).sub(target).abs().lt("0.0000000000000001"), start).toBe(true);
      expect(carry.lt(d(1).div(10 ** szDecimals)), start).toBe(true);
      // Rounding each trim down on its own would have moved nothing for these sizes.
      if (floorSize(d(start).mul("0.01"), szDecimals).isZero) expect(size.lt(start), start).toBe(true);
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

describe("property: the paper ledger's arithmetic is exact (review 9)", () => {
  /** mulberry32. */
  const rng = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

  it("for 300 random sequences of fills, cash is the sum of its ledger rows however they are added up, and every amount has at most 8 decimals", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      let pos = { size: d(0), entryPx: d(0) };
      const ledger: Dec[] = [];
      let cash = d(1_000);
      let fees = d(0);
      let realized = d(0);
      for (let i = 0; i < 25; i++) {
        const px = roundPx(slippedPx(d((20 + r() * 90_000).toFixed(4)), r() < 0.5 ? "B" : "A", 3.3), 5);
        const sign: 1 | -1 = r() < 0.5 ? 1 : -1;
        // Never across zero: a flip is a close and an open.
        const max = pos.size.sign === -sign ? pos.size.abs() : d(3);
        const size = Dec.min(max, floorSize(d((r() * 2).toFixed(7)), 5));
        if (!size.isPositive) continue;
        const next = applyFill(pos, sign, size, px);
        const f = fillFees(size.mul(px), 4.37, 7);
        const funding = fundingPayment(next.size, px, d("0.0000137"), 1 + Math.floor(r() * 3));
        const rows = [next.realizedPnl, f.fee.neg(), f.builderFee.neg(), funding.neg()];
        ledger.push(...rows);
        cash = cash.add(next.realizedPnl).sub(f.fee).sub(f.builderFee).sub(funding);
        fees = fees.add(f.fee).add(f.builderFee);
        realized = realized.add(next.realizedPnl);
        pos = next;
        for (const amount of rows) expect(amount.round(8).eq(amount), `seed ${seed}: ${amount}`).toBe(true);
        expect(pos.entryPx.round(10).eq(pos.entryPx)).toBe(true);
      }
      // Forwards, backwards and largest-first: the same total, exactly.
      const forwards = Dec.sum(ledger);
      const backwards = Dec.sum([...ledger].reverse());
      const sorted = Dec.sum([...ledger].sort((a, b) => b.abs().cmp(a.abs())));
      expect(cash.sub(1_000).eq(forwards), `seed ${seed}`).toBe(true);
      expect(forwards.eq(backwards) && forwards.eq(sorted), `seed ${seed}`).toBe(true);
      expect(cash.toString()).toBe(d(1_000).add(forwards).toString());
      expect(fees.isNegative).toBe(false);
      void realized;
    }
  });

  it("a position opened in pieces and closed in pieces realizes its proceeds less its cost, to within the entry price's tenth decimal", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 31);
      let pos = { size: d(0), entryPx: d(0) };
      let cost = d(0);
      let proceeds = d(0);
      let realized = d(0);
      const buys = Array.from({ length: 1 + Math.floor(r() * 5) }, () => ({ size: d((0.001 + r()).toFixed(5)), px: d((100 + r() * 900).toFixed(2)) }));
      for (const b of buys) { pos = applyFill(pos, 1, b.size, b.px); cost = cost.add(b.size.mul(b.px)); }
      while (pos.size.isPositive) {
        const size = Dec.min(pos.size, d((0.001 + r()).toFixed(5)));
        const px = d((100 + r() * 900).toFixed(2));
        const next = applyFill(pos, -1, size, px);
        proceeds = proceeds.add(size.mul(px));
        realized = realized.add(next.realizedPnl);
        pos = next;
      }
      // Each close rounds once to 8 decimals; the entry price to 10.
      expect(realized.sub(proceeds.sub(cost)).abs().lt("0.000001"), `seed ${seed}: ${realized} vs ${proceeds.sub(cost)}`).toBe(true);
      expect(pos.size.isZero && pos.entryPx.isZero).toBe(true);
    }
  });
});
