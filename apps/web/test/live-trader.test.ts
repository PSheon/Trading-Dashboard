import { describe, expect, it } from "vitest";

import type { TraderFill, TraderProfileResponse } from "../src/lib/contracts";
import {
  deriveLiveProfile,
  initialLiveState,
  liveTraderReducer,
  mergeLiveFills,
  spotPrice,
  traderSubscriptions,
  type LiveEvent,
  type LiveTraderState,
  type WsClearinghouseState,
  type WsFill,
} from "../src/lib/live-trader";

const USER = "0x00000000000000000000000000000000000000aa";

const profile: TraderProfileResponse = {
  address: USER,
  displayName: null,
  stats: null,
  accountValue: 1_000 + 500 + 100,
  perpEquity: 1_000,
  spotValue: 500,
  stakedValue: 100,
  accountMode: "standard",
  spotBalances: [
    { coin: "USDC", token: 0, total: 300, px: 1, value: 300, priceKey: null },
    { coin: "HYPE", token: 150, total: 5, px: 40, value: 200, priceKey: "@107" },
  ],
  perpDexes: ["", "xyz"],
  marginUsed: 200,
  withdrawable: 800,
  longNotional: 3_000,
  shortNotional: 1_000,
  positions: [
    { coin: "BTC", szi: 0.03, side: "long", entryPx: 90_000, positionValue: 3_000, unrealizedPnl: 300, leverage: 10, marginMode: "cross", liqPx: null },
    { coin: "xyz:TSLA", szi: -4, side: "short", entryPx: 260, positionValue: 1_000, unrealizedPnl: 40, leverage: 5, marginMode: "isolated", liqPx: 300 },
  ],
  tracked: false,
  isVault: false,
  favorite: false,
  analytics: null,
  fetchedAt: "2026-09-29T12:00:00.000Z",
};

function chState(dex: string, accountValue: string, positions: Array<[string, string, string, string]>): LiveEvent {
  const data: WsClearinghouseState = {
    dex,
    user: USER,
    clearinghouseState: {
      marginSummary: { accountValue, totalMarginUsed: "50" },
      withdrawable: "10",
      assetPositions: positions.map(([coin, szi, positionValue, unrealizedPnl]) => ({
        position: { coin, szi, positionValue, unrealizedPnl, entryPx: "1", leverage: { type: "cross", value: 3 }, liquidationPx: null },
      })),
    },
  };
  return { type: "clearinghouseState", data, at: 1 };
}

const fill = (tid: number, time: number, coin = "BTC", extra: Partial<WsFill> = {}): WsFill => ({
  coin,
  px: "100",
  sz: "2",
  side: "B",
  time,
  dir: "Open Long",
  closedPnl: "0.0",
  fee: "0.5",
  tid,
  ...extra,
});

const reduce = (events: LiveEvent[], from: LiveTraderState = initialLiveState) => events.reduce(liveTraderReducer, from);

describe("liveTraderReducer", () => {
  it("keeps one clearinghouse state per dex, mapping positions like the api (zero sizes dropped)", () => {
    const state = reduce([
      chState("", "1200", [["BTC", "0.04", "4000", "500"], ["ETH", "0.0", "0", "0"]]),
      chState("xyz", "90", [["xyz:TSLA", "-4", "1100", "-60"]]),
    ]);
    expect(Object.keys(state.perp).sort()).toEqual(["", "xyz"]);
    expect(state.perp[""]).toMatchObject({ perpEquity: 1200, marginUsed: 50, withdrawable: 10 });
    expect(state.perp[""].positions).toEqual([
      { coin: "BTC", szi: 0.04, side: "long", entryPx: 1, positionValue: 4000, unrealizedPnl: 500, leverage: 3, marginMode: "cross", liqPx: null },
    ]);
    expect(state.perp.xyz.positions[0]).toMatchObject({ coin: "xyz:TSLA", side: "short", szi: -4 });
    expect(state.updatedAt).toBe(1);
  });

  it("merges mids across dexes and ignores junk", () => {
    const state = reduce([
      { type: "allMids", data: { mids: { BTC: "100000", "@107": "41", bad: "x" } } },
      { type: "allMids", data: { dex: "xyz", mids: { "xyz:TSLA": "250" } } },
      { type: "allMids", data: { mids: { BTC: "100500" } } },
    ]);
    expect(state.mids).toEqual({ BTC: 100500, "@107": 41, "xyz:TSLA": 250 });
  });

  it("collects perp fills newest first, one per tid, TWAP slices tagged; spot fills skipped", () => {
    const state = reduce([
      { type: "userFills", data: { isSnapshot: true, fills: [fill(1, 1000), fill(2, 2000), fill(9, 2500, "@107"), fill(8, 2600, "PURR/USDC")] } },
      { type: "userTwapSliceFills", data: { isSnapshot: true, twapSliceFills: [{ fill: fill(3, 3000, "xyz:TSLA"), twapId: 77 }] } },
      { type: "userFills", data: { fills: [fill(4, 4000)] } },
      // The same slice again on userFills without its TWAP id: the tagged copy stays.
      { type: "userFills", data: { fills: [fill(3, 3000, "xyz:TSLA", { twapId: null })] } },
    ]);
    expect(state.fills.map((f) => f.tid)).toEqual(["4", "3", "2", "1"]);
    expect(state.fills[1]).toEqual({
      tid: "3",
      coin: "xyz:TSLA",
      side: "buy",
      dir: "Open Long",
      px: 100,
      sz: 2,
      notionalUsd: 200,
      closedPnl: 0,
      fee: 0.5,
      ts: new Date(3000).toISOString(),
      twapId: 77,
    });
    expect(state.fills[0].twapId).toBeNull();
  });

  it("reads the account mode from webData3 and returns the same state for no-ops", () => {
    const state = reduce([{ type: "webData3", data: { userState: { abstraction: "unifiedAccount" } } }]);
    expect(state.abstraction).toBe("unifiedAccount");
    expect(liveTraderReducer(state, { type: "webData3", data: { userState: { abstraction: "unifiedAccount" } } })).toBe(state);
    expect(liveTraderReducer(state, { type: "userFills", data: { fills: [fill(5, 1, "@1")] } })).toBe(state);
    expect(liveTraderReducer(state, { type: "reset" })).toBe(initialLiveState);
  });
});

describe("deriveLiveProfile", () => {
  it("returns the REST profile untouched until something live arrives", () => {
    expect(deriveLiveProfile(profile, initialLiveState)).toBe(profile);
  });

  it("replaces a dex's positions as soon as it reports; equity once every dex has", () => {
    const partial = deriveLiveProfile(profile, reduce([chState("", "1500", [["BTC", "0.03", "3300", "600"]])]));
    expect(partial.positions.map((p) => [p.coin, p.positionValue])).toEqual([
      ["BTC", 3300],
      ["xyz:TSLA", 1000], // still REST
    ]);
    expect(partial.perpEquity).toBe(1000); // xyz not in yet
    expect(partial.longNotional).toBe(3300);

    const full = deriveLiveProfile(
      profile,
      reduce([chState("", "1500", [["BTC", "0.03", "3300", "600"]]), chState("xyz", "60", [])]),
    );
    expect(full.positions.map((p) => p.coin)).toEqual(["BTC"]); // TSLA closed
    expect(full.perpEquity).toBe(1560);
    expect(full.marginUsed).toBe(100);
    expect(full.shortNotional).toBe(0);
    // standard: perp + spot (REST balances, no live mids yet) + staked
    expect(full.accountValue).toBe(1560 + 500 + 100);
  });

  it("revalues spot with live mids near the api's mark and totals by account mode", () => {
    const state = reduce([
      chState("", "1500", []),
      chState("xyz", "0", []),
      { type: "spotState", data: { spotState: { balances: [
        { coin: "USDC", token: 0, total: "300" },
        { coin: "HYPE", token: 150, total: "10" },
        { coin: "+12301", total: "100" },
      ] } }, at: 2 },
      { type: "allMids", data: { mids: { "@107": "42", "#12301": "0.3" } } },
    ]);
    const standard = deriveLiveProfile(profile, state);
    expect(standard.spotValue).toBeCloseTo(300 + 420 + 30, 9);
    expect(standard.spotBalances.map((b) => b.coin)).toEqual(["HYPE", "USDC", "+12301"]);
    expect(standard.accountValue).toBeCloseTo(1500 + 750 + 100, 9);

    const unified = deriveLiveProfile(profile, liveTraderReducer(state, { type: "webData3", data: { userState: { abstraction: "unifiedAccount" } } }));
    expect(unified.accountMode).toBe("unified");
    expect(unified.accountValue).toBeCloseTo(750 + 100, 9); // perp not added
    expect(unified.perpEquity).toBe(1500);
  });

  it("keeps a portfolio-margin answer the socket can't see", () => {
    const pm = { ...profile, accountMode: "portfolioMargin" as const };
    const state = reduce([{ type: "webData3", data: { userState: { abstraction: "disabled" } } }]);
    expect(deriveLiveProfile(pm, state).accountMode).toBe("portfolioMargin");
  });
});

describe("spotPrice", () => {
  const rest = { px: 54.749, priceKey: "@708" };
  it("uses the live mid only near the api's mark", () => {
    expect(spotPrice("THIN", 851, rest, { "@708": 55 })).toBe(55);
    expect(spotPrice("THIN", 851, rest, { "@708": 30 })).toBe(54.749); // illiquid: far-off mid ignored
    expect(spotPrice("THIN", 851, rest, {})).toBe(54.749);
    expect(spotPrice("USDC", 0, undefined, {})).toBe(1);
    expect(spotPrice("NEW", 999, undefined, { "@999": 5 })).toBeNull();
    expect(spotPrice("+5", null, undefined, { "#5": 0.4 })).toBe(0.4);
  });
});

describe("mergeLiveFills", () => {
  const f = (tid: string, ts: number, twapId: number | null = null): TraderFill => ({
    tid, coin: "BTC", side: "buy", dir: "Open Long", px: 1, sz: 1, notionalUsd: 1, closedPnl: null, fee: null, ts: new Date(ts).toISOString(), twapId,
  });

  it("prepends new live fills, dedupes, and doesn't reach past the REST list", () => {
    const rest = [f("5", 5000), f("4", 4000)];
    const merged = mergeLiveFills(rest, [f("7", 7000, 3), f("5", 5000), f("1", 1000)]);
    expect(merged?.map((x) => x.tid)).toEqual(["7", "5", "4"]);
    expect(merged?.[0].twapId).toBe(3);
    expect(mergeLiveFills(rest, [])).toBe(rest);
    expect(mergeLiveFills(undefined, [f("7", 7000)])).toBeUndefined();
  });
});

describe("traderSubscriptions", () => {
  it("covers account state per dex, fills, TWAP slices, the account mode and mids", () => {
    const subs = traderSubscriptions("0xABC", ["", "xyz"]);
    expect(subs).toEqual([
      { type: "webData3", user: "0xabc" },
      { type: "spotState", user: "0xabc" },
      { type: "userFills", user: "0xabc" },
      { type: "userTwapSliceFills", user: "0xabc" },
      { type: "clearinghouseState", user: "0xabc", dex: "" },
      { type: "clearinghouseState", user: "0xabc", dex: "xyz" },
      { type: "allMids", dex: "" },
      { type: "allMids", dex: "xyz" },
    ]);
    // One unique user, well inside Hyperliquid's 10-per-IP limit.
    expect(new Set(subs.flatMap((s) => ("user" in s ? [s.user] : []))).size).toBe(1);
  });
});
