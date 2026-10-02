// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MobileInsights, mobileBias, pieSegments, positioning } from "../src/components/trader/mobile-insights";
import { profileFor } from "../src/fixtures/data";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";
import type { RoundTrip, TraderAnalyticsResponse, TraderProfileResponse } from "../src/lib/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

// 0xbf73…5d58 on CopyDog's app, 2026-10-01: 2.43×, $15.54M notional on
// $6.41M, 85.6% margin used, 57.2% from liquidation, 100% long.
const profile = (): TraderProfileResponse => ({
  ...profileFor(`0x${"bf".repeat(20)}`, false),
  accountValue: 6_400_000,
  perpEquity: 1_820_000,
  stakedValue: 0,
  marginUsed: 1_558_422,
  maintenanceMarginUsed: 779_040,
  longNotional: 15_540_000,
  shortNotional: 0,
  spotBalances: [{ coin: "USDC", token: 0, total: 4_860_000, hold: 0, px: 1, value: 4_860_000, priceKey: null }],
  positions: [{ coin: "PUMP", szi: 1, side: "long", entryPx: 1, positionValue: 15_540_000, unrealizedPnl: 0, leverage: 3, marginMode: "cross", liqPx: null }],
}) as unknown as TraderProfileResponse;

const trade = (id: string, coin: string, netPnl: number) =>
  ({ id, coin, side: "long", status: "closed", netPnl, funding: 0, realizedPnl: netPnl, fees: 0, size: 1, entryPx: 100, exitPx: 110, exitTime: "2026-09-20T00:00:00.000Z", entryTime: "2026-09-19T00:00:00.000Z", holdSeconds: 3600, partial: false, entryApprox: false }) as unknown as RoundTrip;
const analytics = {
  summary: {
    trades: 1070, realizedPnl: 16_090_000, volume: 2_790_000_000, avgHoldSeconds: 37_140,
    best: [trade("a", "ZEC", 5_190_000), trade("b", "ZEC", 5_090_000), trade("c", "ETH", 1_710_000), trade("d", "SOL", 10)],
    worst: [trade("w", "BTC", -154_300)],
    coins: [
      { coin: "ZEC", trades: 128, wins: 1, losses: 1, volume: 351_360_000, netPnl: 15_630_000, winRate: 0.5 },
      { coin: "BTC", trades: 273, wins: 1, losses: 1, volume: 1_210_000_000, netPnl: -154_300, winRate: 0.5 },
    ],
  },
  classification: { style: "intraday", pnlTier: "extremely_profitable", sizeTier: "whale", allTimePnl: null, perpAccountValue: null },
} as unknown as TraderAnalyticsResponse;

const render = (p = profile(), a: TraderAnalyticsResponse | null = analytics) =>
  renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}><MobileInsights profile={p} trades={a ?? undefined} computing={false} /></I18nProvider>);

describe("phone 洞察, CopyDog's layout", () => {
  it("shows 總覽, 持倉佈局, 最佳與最差, 最常交易 and 交易員檔案 in CopyDog's order", () => {
    const html = render();
    const order = ["總覽", "持倉佈局", "帳戶構成", "持倉構成", "最佳與最差", "最常交易", "交易員檔案"].map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const s of ["已實現損益", "+$16.09M", "$2.79B", "1070", "平均持倉時間", "10h 19m"]) expect(html).toContain(s);
  });

  it("reads CopyDog's positioning figures", () => {
    const html = render();
    expect(html).toContain("2.43×");
    expect(html).toContain("$15.54M 名目價值 ▪ $6.40M 淨值");
    expect(html).toContain("85.6%");
    expect(html).toContain("57.2% 距強平");
    expect(html).toContain("極度看漲");
    expect(html).toContain("100.00% ▪ 多");
    const pos = positioning(profile());
    expect(pos.leverage).toBeCloseTo(2.43, 2);
    expect(pos.liqDistancePct).toBeCloseTo(57.2, 1);
  });

  it("builds the donuts: largest first, zero parts dropped, the rest in 其他", () => {
    const html = render();
    expect(html).toContain("$4.86M");
    expect(html).toContain(" ▪ 72.8%");
    expect(html).not.toContain("質押");
    expect(pieSegments([{ label: "a", value: 1 }, { label: "b", value: 0 }, { label: "c", value: 3 }], "o")).toEqual([{ label: "c", value: 3 }, { label: "a", value: 1 }]);
    const many = pieSegments(["A", "B", "C", "D", "E"].map((label, i) => ({ label, value: 10 - i })), "其他", 3);
    expect(many.map((s) => s.label)).toEqual(["A", "B", "C", "其他"]);
    expect(many[3]).toEqual({ label: "其他", value: 13, other: true });
  });

  it("uses CopyDog's mobile bias thresholds", () => {
    expect([80, 55, 50, 45, 21, 20].map((p) => mobileBias(p).key)).toEqual(["veryLong", "long", "neutral", "short", "short", "veryShort"]);
  });

  it("lists three best trades and the most traded coins by count, with the trader profile", () => {
    const html = render();
    expect(html.match(/\+\$5\.\d{2}M/g)?.length).toBe(2);
    expect(html).toContain("+$1.71M");
    expect(html).not.toContain("+$10");
    expect(html.indexOf("273 筆交易")).toBeLessThan(html.indexOf("128 筆交易"));
    expect(html).toContain("日內");
    expect(html).toContain("極度盈利");
    expect(html).toContain("巨鯨");
  });

  it("switches to the worst trades", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<I18nProvider locale="zh-TW" messages={zhTW}><MobileInsights profile={profile()} trades={analytics} computing={false} /></I18nProvider>));
      const worst = [...container.querySelectorAll("button")].find((b) => b.textContent === "最差")!;
      await act(async () => worst.click());
      expect(container.textContent).toContain("-$154.3K");
      expect(container.textContent).not.toContain("+$5.19M");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("says 無曝險 without positions and leaves out figures it doesn't have", () => {
    const html = render({ ...profile(), positions: [], longNotional: 0, shortNotional: 0 }, null);
    expect(html).toContain("無曝險");
    expect(html).not.toContain("總覽");
    expect(html).not.toContain("交易員檔案");
  });
});
