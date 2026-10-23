import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BoardCard, BoardMobileRow, HomeCard } from "../src/components/discover/board-card";
import { KpiTiles, PerformanceChart } from "../src/components/trader/performance";
import { fixtureHome } from "../src/fixtures/discovery";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import type { BoardTrader, PortfolioResponse } from "../src/lib/contracts";
import { cardUsd } from "../src/lib/format";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/" }));
vi.mock("../src/lib/queries", () => ({ useChartSnapshots: () => ({ data: undefined, isPending: false }) }));

/**
 * One number format per context: the same PnL read "+$10,147,718.78" on the
 * explore card, "+$10.15M" in the trader page's summary tile and "+$10.1M"
 * on the home card. Every card and tile now shares one compact figure of
 * three significant digits; the trader page's chart headline keeps the full
 * figure.
 */
const PNL = 10_147_718.78;
const NOW = Date.parse("2026-10-12T12:00:00Z");
const sample = fixtureHome().calculator[0];
const trader = { ...sample, pnl: PNL,
  lastTradeAt: sample.lastTradeAt?.toISOString() ?? null,
  tradesFrom: sample.tradesFrom?.toISOString() ?? null,
  metricsUpdatedAt: null } as unknown as BoardTrader;
const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider locale="en" messages={en}>{node}</I18nProvider>);
const figure = (html: string) => html.match(/[+-]\$[\d,.]+[KMBT]?/g) ?? [];

describe("one compact figure on every card and tile", () => {
  it("is three significant digits, the unit carrying a round-up", () => {
    expect(cardUsd(PNL, { sign: true })).toBe("+$10.1M");
    expect(cardUsd(959_000, { sign: true })).toBe("+$959K");
    expect(cardUsd(58_900_000, { sign: true })).toBe("+$58.9M");
    expect(cardUsd(4_800_000, { sign: true })).toBe("+$4.80M");
    expect(cardUsd(999_600)).toBe("$1.00M");
    expect(cardUsd(99.96)).toBe("$100");
    expect(cardUsd(-12_400, { sign: true })).toBe("-$12.4K");
    expect(cardUsd(958)).toBe("$958");
    expect(cardUsd(58.9)).toBe("$58.9");
    expect(cardUsd(0.001, { sign: true })).toBe("$0");
    expect(cardUsd(1_234_567_890_123)).toBe("$1.23T");
    expect(cardUsd(null)).toBe("—");
  });

  it("the explore card, the home card, the phone row and the summary tile all print the same string", () => {
    const explore = render(<BoardCard trader={trader} pnlLabel="PnL" roiLabel="ROI" now={NOW} />);
    const home = render(<HomeCard trader={trader} />);
    const row = render(<ul><BoardMobileRow trader={trader} /></ul>);
    const tiles = render(<KpiTiles period="allTime" onPeriod={() => {}} lowSample={false} trades={undefined} tradesComputing={false} now={NOW}
      periodPortfolio={{ pnl: [[NOW - 86_400_000, 0], [NOW, PNL]], roi: 18.4 } as unknown as PortfolioResponse} allTime={undefined} />);
    for (const html of [explore, home, row, tiles]) expect(figure(html)).toContain("+$10.1M");
    for (const html of [explore, home, row, tiles]) {
      expect(html).not.toContain("+$10,147,718");
      expect(html).not.toContain("+$10.15M");
    }
  });

  it("the chart headline keeps the full figure", () => {
    const portfolio = { pnl: [[NOW - 86_400_000, 0], [NOW, PNL]], accountValue: [[NOW - 86_400_000, 1], [NOW, 2]], cumulativeReturn: [[NOW, 18.4]], roi: 18.4 } as unknown as PortfolioResponse;
    const html = render(<PerformanceChart address={trader.address} portfolio={portfolio} loading={false} window="allTime" onWindow={() => {}} mode="pnl" onMode={() => {}} unit="usd" onUnit={() => {}} market="perp" onMarket={() => {}} muted={false} roi={18.4} />);
    expect(html).toContain("+$10,147,718.78");
  });
});
