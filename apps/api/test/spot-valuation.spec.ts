import { readFileSync } from "node:fs";

import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type {
  HlAllMidsResponse,
  HlDelegatorSummary,
  HlSpotBalance,
  HlSpotMetaAndAssetCtxsResponse,
} from "../src/hyperliquid/types.js";
import { SPOT_PRICE_TTL_MS, SpotPriceService } from "../src/traders/spot-price.service.js";
import {
  buildSpotPriceBook,
  hypePrice,
  stakedHype,
  toAccountMode,
  totalAccountValue,
  valueSpotBalances,
} from "../src/traders/spot-prices.js";

const bal = (coin: string, token: number | undefined, total: string): HlSpotBalance => ({
  coin,
  ...(token === undefined ? {} : { token }),
  total,
  hold: "0",
  entryNtl: "0",
});

/**
 * USDC; PURR (the "PURR/USDC" pair); HYPE (@107, canonical USDC pair, plus
 * a USDT0 pair that must not win); USDT0 (@166 vs USDC); ONLYT (quoted only
 * in USDT0, @900); THIN (USDC pair @708 with a stale mid far from its mark);
 * NOMARK (mark 0, mid only); DEAD (a pair with no price at all); JUNK (no
 * pair). Contexts are shuffled, as Hyperliquid's are.
 */
const market: HlSpotMetaAndAssetCtxsResponse = [
  {
    tokens: [
      { name: "USDC", index: 0 },
      { name: "PURR", index: 1 },
      { name: "HYPE", index: 150 },
      { name: "USDT0", index: 268 },
      { name: "ONLYT", index: 500 },
      { name: "THIN", index: 851 },
      { name: "NOMARK", index: 852 },
      { name: "DEAD", index: 853 },
      { name: "JUNK", index: 999 },
    ],
    universe: [
      { name: "PURR/USDC", index: 0, tokens: [1, 0], isCanonical: true },
      { name: "@207", index: 207, tokens: [150, 268] },
      { name: "@107", index: 107, tokens: [150, 0], isCanonical: true },
      { name: "@166", index: 166, tokens: [268, 0] },
      { name: "@900", index: 900, tokens: [500, 268] },
      { name: "@708", index: 708, tokens: [851, 0] },
      { name: "@709", index: 709, tokens: [852, 0] },
      { name: "@710", index: 710, tokens: [853, 0] },
    ],
  },
  [
    { coin: "@708", markPx: "54.749", midPx: "30.0045" },
    { coin: "@900", markPx: "2", midPx: "2.1" },
    { coin: "@207", markPx: "41", midPx: "41" },
    { coin: "@107", markPx: "40", midPx: "40.2" },
    { coin: "@166", markPx: "0.999", midPx: "0.999" },
    { coin: "PURR/USDC", markPx: "0.2", midPx: "0.21" },
    { coin: "@709", markPx: "0", midPx: "3" },
    { coin: "@710", markPx: "0", midPx: null },
  ],
];
const mids: HlAllMidsResponse = { "@107": "40.2", "#12301": "0.25", "#12300": "0.75", BTC: "100000" };

describe("spot valuation", () => {
  const book = buildSpotPriceBook(market, mids);

  it("values USDC at 1 and a USDC pair's token at the pair's mark", () => {
    const { spotValue, balances } = valueSpotBalances(
      [bal("USDC", 0, "1000.5"), bal("HYPE", 150, "10"), bal("PURR", 1, "100")],
      book,
    );
    expect(spotValue).toBeCloseTo(1000.5 + 400 + 20, 9);
    expect(balances).toEqual([
      { coin: "USDC", token: 0, total: 1000.5, hold: 0, px: 1, value: 1000.5, priceKey: null },
      { coin: "HYPE", token: 150, total: 10, hold: 0, px: 40, value: 400, priceKey: "@107" },
      { coin: "PURR", token: 1, total: 100, hold: 0, px: 0.2, value: 20, priceKey: "PURR/USDC" },
    ]);
  });

  it("uses the mark, not a far-off mid, for an illiquid pair; the mid only when there is no mark", () => {
    const { balances } = valueSpotBalances([bal("THIN", 851, "100"), bal("NOMARK", 852, "1")], book);
    expect(balances.find((b) => b.coin === "THIN")?.px).toBe(54.749);
    expect(balances.find((b) => b.coin === "NOMARK")?.px).toBe(3);
  });

  it("prices a token quoted only in another token through that token's USDC price", () => {
    const { balances } = valueSpotBalances([bal("ONLYT", 500, "10")], book);
    // 2 USDT0 × 0.999 USDC; no USDC key to track it live.
    expect(balances[0]).toMatchObject({ px: 1.998, priceKey: null });
    expect(balances[0].value).toBeCloseTo(19.98, 9);
  });

  it("values prediction-market outcome tokens (\"+N\") at allMids[\"#N\"]", () => {
    const { spotValue, balances } = valueSpotBalances([bal("+12301", undefined, "1000"), bal("+12300", undefined, "10")], book);
    expect(spotValue).toBeCloseTo(250 + 7.5, 9);
    expect(balances[0]).toEqual({ coin: "+12301", token: null, total: 1000, hold: 0, px: 0.25, value: 250, priceKey: "#12301" });
  });

  it("counts unknown and unpriced tokens as 0 and reports each", () => {
    const unpriced: Array<[string, number | null]> = [];
    const { spotValue, balances } = valueSpotBalances(
      [bal("USDC", 0, "5"), bal("JUNK", 999, "1e9"), bal("DEAD", 853, "7"), bal("+777", undefined, "3"), bal("??", undefined, "1")],
      book,
      (coin, token) => unpriced.push([coin, token]),
    );
    expect(spotValue).toBe(5);
    expect(unpriced).toEqual([
      ["JUNK", 999],
      ["DEAD", 853],
      ["+777", null],
      ["??", null],
    ]);
    expect(balances.find((b) => b.coin === "JUNK")).toMatchObject({ px: null, value: 0, priceKey: null });
  });

  it("skips zero balances and sorts by value", () => {
    const { balances } = valueSpotBalances([bal("PURR", 1, "1"), bal("USDT0", 268, "0.0"), bal("HYPE", 150, "1")], book);
    expect(balances.map((b) => b.coin)).toEqual(["HYPE", "PURR"]);
  });

  it("values staked HYPE (delegated + undelegated + pending) at HYPE's price", () => {
    const summary: HlDelegatorSummary = { delegated: "100", undelegated: "5", totalPendingWithdrawal: "2.5", nPendingWithdrawals: 1 };
    expect(stakedHype(summary)).toBe(107.5);
    expect(hypePrice(book)).toBe(40);
    expect(hypePrice(buildSpotPriceBook([{ tokens: [], universe: [] }, []], {}))).toBe(0);
  });

  it("maps Hyperliquid's account modes and totals each", () => {
    expect(toAccountMode("unifiedAccount")).toBe("unified");
    expect(toAccountMode("portfolioMargin")).toBe("portfolioMargin");
    expect(toAccountMode("disabled", true)).toBe("portfolioMargin");
    for (const m of ["disabled", "default", "dexAbstraction", "somethingNew", null]) expect(toAccountMode(m)).toBe("standard");
    expect(totalAccountValue("standard", 100, 50, 7)).toBe(157);
    expect(totalAccountValue("unified", 100, 50, 7)).toBe(57);
    expect(totalAccountValue("portfolioMargin", 100, 50, 7)).toBe(57);
  });

  /**
   * A real snapshot (captured 2026-09-29 from mainnet, trimmed to the pairs
   * these accounts hold): unified, portfolio-margin and standard accounts,
   * one with $60M of staked HYPE and 40+ meme tokens, one holding outcome
   * tokens, one with an illiquid token only its mark prices right. Our total
   * must match Hyperliquid's own `portfolio` total.
   */
  it("matches Hyperliquid's portfolio total on a live snapshot", () => {
    const snap = JSON.parse(readFileSync(new URL("./fixtures/spot-valuation-live.json", import.meta.url), "utf8")) as {
      spotMetaAndAssetCtxs: HlSpotMetaAndAssetCtxsResponse;
      allMids: HlAllMidsResponse;
      accounts: Array<{
        user: string;
        abstraction: string;
        portfolioMarginEnabled: boolean;
        balances: HlSpotBalance[];
        delegatorSummary: HlDelegatorSummary;
        perpEquity: number;
        hlTotal: number;
      }>;
    };
    const live = buildSpotPriceBook(snap.spotMetaAndAssetCtxs, snap.allMids);
    const modes = new Set<string>();
    for (const a of snap.accounts) {
      const mode = toAccountMode(a.abstraction, a.portfolioMarginEnabled);
      modes.add(mode);
      const { spotValue } = valueSpotBalances(a.balances, live);
      const total = totalAccountValue(mode, a.perpEquity, spotValue, stakedHype(a.delegatorSummary) * hypePrice(live));
      expect(Math.abs(total - a.hlTotal) / a.hlTotal, `${a.user} ${mode}: ours ${total}, Hyperliquid ${a.hlTotal}`).toBeLessThan(0.002);
    }
    expect([...modes].sort()).toEqual(["portfolioMargin", "standard", "unified"]);
  });
});

describe("SpotPriceService", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function fakeInfo() {
    return {
      spotMetaAndAssetCtxs: vi.fn(async () => market),
      allMids: vi.fn(async () => mids),
    };
  }

  it("fetches one price book per 30 s app-wide, de-duplicating concurrent loads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const info = fakeInfo();
    const service = new SpotPriceService(info as unknown as HyperliquidInfoClient);
    const [a, b] = await Promise.all([service.book("background", 0), service.book("background", 0)]);
    expect(a).toBe(b);
    expect(info.spotMetaAndAssetCtxs).toHaveBeenCalledTimes(1);
    expect(info.spotMetaAndAssetCtxs).toHaveBeenCalledWith("background", 0);
    expect(info.allMids).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SPOT_PRICE_TTL_MS - 1);
    await service.book();
    expect(info.spotMetaAndAssetCtxs).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await service.book();
    expect(info.spotMetaAndAssetCtxs).toHaveBeenCalledTimes(2);
  });

  it("doesn't cache a failed load, and survives allMids failing (outcomes then count 0)", async () => {
    const info = fakeInfo();
    info.spotMetaAndAssetCtxs.mockRejectedValueOnce(new Error("Hyperliquid info request failed: 500"));
    info.allMids.mockRejectedValue(new Error("Hyperliquid info request failed: 500"));
    const service = new SpotPriceService(info as unknown as HyperliquidInfoClient);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await expect(service.book()).rejects.toThrow("500");
    const book = await service.book();
    expect(info.spotMetaAndAssetCtxs).toHaveBeenCalledTimes(2);
    expect(service.value([bal("+12301", undefined, "10"), bal("HYPE", 150, "1")], book).spotValue).toBe(40);
  });

  it("logs an unpriced token once per process", () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const service = new SpotPriceService(fakeInfo() as unknown as HyperliquidInfoClient);
    const book = buildSpotPriceBook(market, mids);
    service.value([bal("JUNK", 999, "1")], book);
    service.value([bal("JUNK", 999, "2"), bal("DEAD", 853, "1")], book);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      "No price for spot token JUNK (token 999); valued at 0",
      "No price for spot token DEAD (token 853); valued at 0",
    ]);
  });
});
