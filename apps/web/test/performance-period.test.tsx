import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { zhTW } from "../src/i18n/messages/zh-TW";
import { wireTraderAnalyticsSchema } from "@trading-dashboard/shared/contracts";
import { fixtureAnalytics } from "../src/fixtures/trades";
import { KpiTiles, TRADE_WINDOW } from "../src/components/trader/performance";
import type { TraderProfileResponse } from "../src/lib/contracts";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const analytics = { winRate30d: 0.75, roundTrips30d: 4, realizedPnl30d: 100, avgHoldSeconds: 3600, bestCoins: [], worstCoins: [] };
function render(window: "day" | "week" | "month" | "allTime", tracked = true, locale: "en" | "zh-TW" = "en") {
  const trades = wireTraderAnalyticsSchema.parse(JSON.parse(JSON.stringify(fixtureAnalytics(`0x${"ab".repeat(20)}`, TRADE_WINDOW[window]))));
  trades.summary.trades = 4;
  trades.summary.winRate = 0.25;
  return renderToStaticMarkup(
    <I18nProvider locale={locale} messages={locale === "en" ? en : zhTW}>
      <KpiTiles profile={{ analytics: tracked ? analytics : null } as TraderProfileResponse}
        trades={tracked ? trades : undefined} tradesComputing={false} portfolio={undefined} allTime={undefined} window={window} market="all" lowSample={false} />
    </I18nProvider>,
  );
}
describe("selected-period net win rate", () => {
  for (const window of ["day", "week", "month", "allTime"] as const) {
    it(`uses the trade analytics response when the chart is ${window}`, () => {
      const html = render(window);
      expect(html).toContain("Win rate (perps)");
      expect(html).toContain("4 recorded perp round trips");
      expect(html).toContain("after fees, before funding");
      expect(html).toContain("25%");
      expect(html).not.toContain("75%");
    });
  }
  it("does not describe missing analytics as an absence of trades", () => {
    expect(render("day", false)).toContain("Recorded analytics unavailable");
  });
  it("explains the same scope in Traditional Chinese", () => {
    expect(render("week", true, "zh-TW")).toContain("勝率（永續）");
  });
});
