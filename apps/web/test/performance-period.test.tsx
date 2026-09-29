import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { zhTW } from "../src/i18n/messages/zh-TW";
import { KpiTiles } from "../src/components/trader/performance";
import type { TraderProfileResponse } from "../src/lib/contracts";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
const analytics = { winRate30d: 0.75, roundTrips30d: 4, realizedPnl30d: 100, avgHoldSeconds: 3600, bestCoins: [], worstCoins: [] };
function render(window: "day" | "week" | "month" | "allTime", tracked = true, locale: "en" | "zh-TW" = "en") {
  return renderToStaticMarkup(
    <I18nProvider locale={locale} messages={locale === "en" ? en : zhTW}>
      <KpiTiles profile={{ analytics: tracked ? analytics : null } as TraderProfileResponse}
        portfolio={undefined} allTime={undefined} window={window} market="all" lowSample={false} />
    </I18nProvider>,
  );
}
describe("recorded win-rate period", () => {
  for (const window of ["day", "week", "month", "allTime"] as const) {
    it(`explicitly retains the 30-day scope when the chart is ${window}`, () => {
      const html = render(window);
      expect(html).toContain("Win rate (30d)");
      expect(html).toContain("4 recorded perp round trips");
      expect(html).toContain("Before fees and funding");
    });
  }
  it("does not describe missing analytics as an absence of trades", () => {
    expect(render("day", false)).toContain("Recorded analytics unavailable");
  });
  it("explains the same scope in Traditional Chinese", () => {
    expect(render("week", true, "zh-TW")).toContain("勝率（30天）");
  });
});
