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

beforeEach(() => {
  read.accountValue = 100_000;
  read.fillsError = false;
  read.fills = [fill("NEAR", 5.3864, 1000, 1), fill("BTC", 100_000, 0.2, 2), fill("xyz:MU", 100, 10, 3)];
});

it("warns how many recent opens a small ratio copy would leave under the minimum, and the HIP-3 ones apart", () => {
  const html = render(100);
  expect(html).toContain("跟單適配估算");
  expect(html).toContain("最近 3 筆開倉中約 1 筆（33%）會低於最低下單額 $10");
  expect(html).toContain("另有 1 筆是 HIP-3 市場");
  expect(html).toContain("Oct 10, 01:01 – Oct 10, 01:03");
  expect(html).toContain("bg-warning/10");
});

it("says when every open fits, and shows nothing before an amount is typed", () => {
  read.fills = [fill("BTC", 100_000, 0.2, 2)];
  expect(render(100)).toContain("都達到最低下單額 $10");
  expect(render(100)).not.toContain("bg-warning/10");
  expect(render(0)).toBe("");
});

it("does not guess without the leader's account value", () => {
  read.accountValue = null;
  expect(render(100)).toContain("讀不到交易員帳戶價值");
});

it("says the fills could not be read instead of showing nothing", () => {
  read.fills = undefined;
  expect(render(100)).toBe("");
  read.fillsError = true;
  expect(render(100)).toContain("暫時讀不到交易員的近期成交");
});
