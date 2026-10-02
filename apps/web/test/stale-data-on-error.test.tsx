import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CoinIndexView } from "../src/components/coins/coins-view";
import { CrowdView } from "../src/components/insights/crowd-view";
import { OrdersTab, TwapTab } from "../src/components/trader/trader-tabs";
import { en } from "../src/i18n/messages/en";
import { I18nProvider } from "../src/i18n/provider";

/** What a query hook returns: `failedPoll` is a background refetch that
 * failed after data had loaded; `failedLoad` never had any. */
const state = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
const failed = { isError: true, error: new Error("503 busy"), refetch() {} };
const failedPoll = (data: unknown) => ({ ...failed, data });
const failedLoad = { ...failed, data: undefined };

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("../src/lib/queries", () => ({
  isComputing: () => false,
  useTraderOrders: () => state.result,
  useTraderTwap: () => state.result,
  useTraderTransfers: () => state.result,
  useTraderTrades: () => state.result,
  useCoinIndex: () => state.result,
  useCoinBoard: () => state.result,
  useCrowd: () => state.result,
}));

const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider locale="en" messages={en}>{node}</I18nProvider>);
const ADDRESS = `0x${"ab".repeat(20)}`;
/** As it appears in markup (the apostrophe is escaped). */
const FAILED_LINE = en.trader.analyticsFailed.replaceAll("'", "&#x27;");
const order = { oid: "1", coin: "ZEC", side: "buy", orderType: "Limit", size: 2, origSize: 2, limitPx: 250, triggerPx: null, isTrigger: false, triggerCondition: null, reduceOnly: false, isPositionTpsl: false, placedAt: new Date("2026-10-01T00:00:00Z") };
const twap = { twapId: 7, coin: "HYPE", side: "sell", size: 100, filledSize: 25, filledFraction: 0.25, minutes: 30, reduceOnly: false, randomize: false, startedAt: new Date("2026-10-01T00:00:00Z") };

describe("a failed background poll keeps the data already on screen (review 60)", () => {
  beforeEach(() => { state.result = {}; });

  it("訂單: the loaded orders stay; the error line is only for a load that never succeeded", () => {
    state.result = failedPoll({ orders: [order], dexes: [""], fetchedAt: new Date() });
    const kept = render(<OrdersTab address={ADDRESS} />);
    expect(kept).toContain("ZEC");
    expect(kept).not.toContain(FAILED_LINE);

    state.result = failedLoad;
    expect(render(<OrdersTab address={ADDRESS} />)).toContain(FAILED_LINE);
  });

  it("TWAP: the same", () => {
    state.result = failedPoll({ twaps: [twap], fetchedAt: new Date() });
    const kept = render(<TwapTab address={ADDRESS} />);
    expect(kept).toContain("HYPE");
    expect(kept).not.toContain(FAILED_LINE);

    state.result = failedLoad;
    expect(render(<TwapTab address={ADDRESS} />)).toContain(FAILED_LINE);
  });

  it("/coins: the market table stays", () => {
    state.result = failedPoll({ items: [{ coin: "BTC", market: "crypto", traders: 12, profit: 3_400_000 }], pool: {}, updatedAt: null });
    const kept = render(<CoinIndexView />);
    expect(kept).toContain("BTC");
    expect(kept).not.toContain(en.common.error);

    state.result = failedLoad;
    expect(render(<CoinIndexView />)).toContain(en.common.error);
  });

  it("洞察 crowd: a load that never succeeded still shows the error and its retry", () => {
    state.result = failedLoad;
    const html = render(<CrowdView onCoin={() => {}} />);
    expect(html).toContain(en.common.error);
    expect(html).toContain(en.common.retry);
  });
});
