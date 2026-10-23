import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

import { zhTW } from "../src/i18n/messages/zh-TW";
import { I18nProvider } from "../src/i18n/provider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const read = vi.hoisted(() => ({ accountValue: 100_000 as number | null, fills: [] as unknown[] | undefined, fillsError: false }));
vi.mock("../src/lib/queries", () => ({
  useTraderProfile: () => ({ data: { accountValue: read.accountValue } }),
  useTraderFills: () => ({ data: read.fills, isError: read.fillsError }),
}));

import { CopyFitSummary } from "../src/components/trader/copy-fit-summary";

const fill = (coin: string, px: number, sz: number, minute: number) =>
  ({ tid: `${coin}${minute}`, coin, side: "buy", dir: "Open Long", px, sz, notionalUsd: px * sz, closedPnl: null, fee: null, ts: new Date(Date.UTC(2026, 9, 10, 1, minute)).toISOString() });
const render = (allocation: number) => renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}><CopyFitSummary address={`0x${"ab".repeat(20)}`} allocation={allocation} /></I18nProvider>);
/** The pill's visible text: what is outside its ⓘ (the sentence is in the tip's hidden span). */
const pillText = (html: string, testId: string) => html.match(new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`))?.[1] ?? null;
/** The pill's hover tip (InfoTip's visually hidden copy of it). */
const pillTip = (html: string, testId: string) => html.slice(html.indexOf(`data-testid="${testId}"`)).match(/class="sr-only">([^<]*)</)?.[1] ?? null;

beforeEach(() => {
  read.accountValue = 100_000;
  read.fillsError = false;
  read.fills = [fill("NEAR", 5.3864, 1000, 1), fill("BTC", 100_000, 0.2, 2), fill("xyz:MU", 100, 10, 3)];
});

it("is one warning pill per finding (the opens under the minimum, the HIP-3 ones apart), the sentences in their tips (UI rule: states are pills)", () => {
  const html = render(100);
  expect(pillText(html, "copy-fit-below-min")).toBe("1/3 筆低於最低額");
  expect(html).toContain('data-testid="copy-fit-below-min" data-warn="true"');
  expect(pillTip(html, "copy-fit-below-min")).toContain("最近 3 筆開倉中約 1 筆（33%）會低於最低下單額 $10");
  expect(pillTip(html, "copy-fit-below-min")).toContain("Oct 10, 01:01 – Oct 10, 01:03");
  expect(pillText(html, "copy-fit-hip3")).toBe("1 筆 HIP-3");
  expect(pillTip(html, "copy-fit-hip3")).toContain("另有 1 筆是 HIP-3 市場");
  // The ⓘ is named after the box that used to carry the sentences.
  expect(html).toContain('aria-label="跟單適配估算"');
  // No sentence on screen: no paragraph, and the sentences only inside the hidden tips.
  expect(html).not.toMatch(/<p[ >]/);
  expect(html.split("會低於最低下單額")).toHaveLength(2);
});

it("is a quiet pill when every open fits, and nothing before an amount is typed", () => {
  read.fills = [fill("BTC", 100_000, 0.2, 2)];
  const html = render(100);
  expect(pillText(html, "copy-fit-below-min")).toBe("1 筆皆達最低額");
  expect(html).not.toContain("data-warn");
  expect(pillTip(html, "copy-fit-below-min")).toContain("都達到最低下單額 $10");
  expect(html).not.toContain("copy-fit-hip3");
  expect(render(0)).toBe("");
});

it("does not guess without the leader's account value", () => {
  read.accountValue = null;
  const html = render(100);
  expect(pillText(html, "copy-fit-unknown-equity")).toBe("缺帳戶價值");
  expect(pillTip(html, "copy-fit-unknown-equity")).toContain("讀不到交易員帳戶價值");
});

it("says the fills could not be read instead of showing nothing", () => {
  read.fills = undefined;
  expect(render(100)).toBe("");
  read.fillsError = true;
  const html = render(100);
  expect(pillText(html, "copy-fit-unavailable")).toBe("暫無法估算");
  expect(pillTip(html, "copy-fit-unavailable")).toContain("暫時讀不到交易員的近期成交");
});

it("suggests no amount of its own, even when every open would be skipped: the api's suggested minimum budget is the one rule (D7, 2026-10-23)", () => {
  // Leader 1,000,000 with opens of 1k…10k: at 50 every one is under $10 — the old summary said 建議至少 $3,340 here.
  read.accountValue = 1_000_000;
  read.fills = Array.from({ length: 10 }, (_, i) => fill("BTC", 1000, i + 1, i));
  const html = render(50);
  expect(pillText(html, "copy-fit-below-min")).toBe("10/10 筆低於最低額");
  expect(html).toContain("不會執行");
  expect(html).not.toContain("建議至少");
  expect(html).not.toContain("copy-fit-suggested");
  expect((zhTW.trader.copy.fit as Record<string, string>).suggested).toBeUndefined();
});

it("never says an open under the minimum is raised: the test floor is gone (D6, 2026-10-23)", () => {
  read.accountValue = 1_000_000;
  read.fills = Array.from({ length: 10 }, (_, i) => fill("BTC", 1000, i + 1, i));
  const html = render(50);
  expect(html).not.toContain("測試模式");
  expect(html).toContain("不會執行");
  expect(html).toContain('data-warn="true"');
  expect((zhTW.trader.copy.fit as Record<string, string>).raised).toBeUndefined();
});
