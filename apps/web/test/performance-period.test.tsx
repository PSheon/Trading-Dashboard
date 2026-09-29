import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { zhTW } from "../src/i18n/messages/zh-TW";
import { KpiTiles } from "../src/components/trader/performance";
import type { TraderAnalyticsResponse, TraderProfileResponse } from "../src/lib/contracts";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const trades = (winRate: number | null, count: number) =>
  ({ summary: { winRate, trades: count } }) as unknown as TraderAnalyticsResponse;

function render(opts: { trades?: TraderAnalyticsResponse; computing?: boolean; locale?: "en" | "zh-TW" }) {
  const locale = opts.locale ?? "en";
  return renderToStaticMarkup(
    <I18nProvider locale={locale} messages={locale === "en" ? en : zhTW}>
      <KpiTiles profile={{ analytics: null } as TraderProfileResponse} portfolio={undefined} allTime={undefined}
        window="month" market="all" lowSample={false} trades={opts.trades} tradesComputing={opts.computing ?? false} />
    </I18nProvider>,
  );
}

describe("win-rate tile (CopyDog's definition, any address)", () => {
  it("shows the window's win rate to one decimal with its trade count", () => {
    const html = render({ trades: trades(0.2917, 24) });
    expect(html).toContain("29.2%");
    expect(html).toContain("24 trades");
    expect(html).toContain("text-negative");
  });
  it("colours like CopyDog: 50% and up green, 35% and up amber", () => {
    expect(render({ trades: trades(0.551, 98) })).toContain("text-positive");
    expect(render({ trades: trades(0.4, 5) })).toContain("text-warning");
  });
  it("says it is computing while a cold address is reconstructed", () => {
    expect(render({ computing: true })).toContain("Computing…");
  });
  it("uses CopyDog's Traditional Chinese labels", () => {
    const html = render({ trades: trades(0.615, 13), locale: "zh-TW" });
    expect(html).toContain("勝率");
    expect(html).toContain("13 筆交易");
  });
});
