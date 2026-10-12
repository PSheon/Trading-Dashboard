import { COHORT_HEADLINE_MIN_COVERAGE, cohortDetailResponseSchema, cohortHeadlineReady, cohortHistoryResponseSchema, wireCohortDetailSchema } from "@trading-dashboard/shared/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { InsightsView } from "../src/components/insights/insights-view";
import { fixtureCohort, fixtureCohortHistory } from "../src/fixtures/discovery";
import { zhTW } from "../src/i18n/messages/zh-TW";
import { catalogs } from "../src/i18n/messages";
import { I18nProvider } from "../src/i18n/provider";

const state = vi.hoisted(() => ({ detail: undefined as unknown, history: undefined as unknown }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("../src/lib/queries", () => ({
  useCohort: () => ({ data: state.detail, isError: false, refetch() {} }),
  useCohortHistory: () => ({ data: state.history, errorUpdateCount: 0, refetch() {} }),
}));

const wireOf = (tier: string) => JSON.parse(JSON.stringify(cohortDetailResponseSchema.parse(fixtureCohort(tier))));
const render = () => renderToStaticMarkup(<I18nProvider locale="zh-TW" messages={zhTW}><InsightsView /></I18nProvider>);

/** Review finding 52: on Stage 33 of 150 members gave "極度看空 6.9% 做多" where the full tier read 41.8 %. */
describe("the insights headline waits for the tier to be read", () => {
  it("the lab includes a usable partial tier between the headline and complete coverage gates", () => {
    expect(fixtureCohort("very_profitable")).toMatchObject({ memberCount: 150, walletCount: 120, headlineReady: true });
  });
  it("the rule: four fifths of the members must have a fresh snapshot", () => {
    expect(COHORT_HEADLINE_MIN_COVERAGE).toBe(0.8);
    expect(cohortHeadlineReady(33, 150)).toBe(false);
    expect(cohortHeadlineReady(119, 150)).toBe(false);
    expect(cohortHeadlineReady(120, 150)).toBe(true);
    expect(cohortHeadlineReady(0, 0)).toBe(false);
  });

  it("a fully read tier shows its split cards as CopyDog does, and no coverage label", () => {
    state.detail = wireOf("extremely_profitable");
    state.history = JSON.parse(JSON.stringify(cohortHistoryResponseSchema.parse(fixtureCohortHistory("extremely_profitable", "all"))));
    const html = render();
    expect(html).toContain("未實現盈虧");
    expect(html).toContain("68.9%");
    expect(html).toContain("做多");
    expect(html).not.toContain(zhTW.insights.cohort.building);
    expect(html).toContain(zhTW.insights.cohort.notional);
    // Nothing CopyDog's page lacks: no "x / y wallets" line.
    expect(html).not.toMatch(/個錢包有最新快照/);
  });

  it.each([true, false])("discloses a partial current summary above the 80 percent gate (explicit readiness: %s)", (explicit) => {
    const partial: Record<string, unknown> = { ...wireOf("extremely_profitable"), walletCount: 120, memberCount: 150, headlineReady: true, updatedAt: null };
    if (!explicit) delete partial.headlineReady;
    state.detail = partial;
    state.history = undefined;
    const html = render();
    expect(html).toContain("68.9%");
    expect(html).not.toContain(zhTW.insights.cohort.building);
    // One pill by the title (text density review 2026-10-12): the counts on
    // it, the sentence as its accessible name.
    expect(html).toContain('data-testid="cohort-coverage"');
    expect(html).toMatch(/data-testid="cohort-coverage"[^>]*>[\s\S]*?120\/150/);
    expect(html).toContain('aria-label="120 / 150 個錢包有最新快照"');
  });

  it("a tier read to 33 of 150 shows no headline figure: the cards are placeholders and the page says it is building", () => {
    state.detail = wireOf("rekt");
    state.history = { tier: "rekt", window: "all", series: [], btc: [] };
    const html = render();
    expect(state.detail).toMatchObject({ walletCount: 33, memberCount: 150, headlineReady: false, hero: { longPct: 6.9 } });
    // Both split cards are their placeholders (the card and its title, no
    // figure), so the partial read's "7% 做多" is nowhere; the per-market map
    // waits as well.
    expect(html.match(/<section aria-hidden="true" class="orbit-card card-pad ui-skeleton/g)).toHaveLength(2);
    expect(html).not.toContain(`7% ${zhTW.insights.cohort.long}`);
    expect(html).not.toContain("$69.00K");
    expect(html).toContain(zhTW.insights.cohort.building);
    // The wallets that were read are still listed.
    expect(html).toContain("<table");
  });

  it("an api without the field is judged by the two counts", () => {
    const old = wireOf("rekt");
    delete old.headlineReady;
    expect(wireCohortDetailSchema.parse(old).headlineReady).toBeUndefined();
    state.detail = old;
    expect(render()).toContain(zhTW.insights.cohort.building);
    const full = wireOf("extremely_profitable");
    delete full.headlineReady;
    state.detail = full;
    state.history = undefined;
    expect(render()).not.toContain(zhTW.insights.cohort.building);
  });
});

it("labels surviving historical percentages when current coverage is insufficient", () => {
  state.detail = wireOf("rekt");
  state.history = JSON.parse(JSON.stringify(cohortHistoryResponseSchema.parse(fixtureCohortHistory("extremely_profitable", "all"))));
  const html = render();
  expect(html).toContain(zhTW.copyUpdates.historical);
  expect(html).toContain("33/150");
  expect(html).toContain("<time dateTime=");
  // 重試 is in the pill's explanation, opened by a press (insights-coverage-pill.test.tsx).
  expect(html).toContain('data-testid="cohort-coverage"');
});

describe("insights say what they show (audit 2026-10-07 P1-8)", () => {
  it.each([[72, 28], [1, 99]])("aligns profitable and losing wallet proportions with their respective PnL sides (%s/%s wallets)", (walletsInProfit, walletsInLoss) => {
    const full = wireOf("extremely_profitable");
    state.detail = { ...full, hero: { ...full.hero, walletsInProfit, walletsInLoss, upnlProfitPct: 61 } };
    state.history = undefined;
    const root = new Window().document.createElement("div");
    root.innerHTML = render();
    const card = [...root.querySelectorAll("h2")].find(node => node.textContent === zhTW.insights.cohort.unrealizedPnl)!.closest("section")!;
    const [left, right] = card.querySelector(".cd-bar")!.nextElementSibling!.children;
    const profit = Math.round(100 * walletsInProfit / (walletsInProfit + walletsInLoss));
    expect(left.textContent).toContain(`${profit}% ${zhTW.insights.cohort.inProfit}`);
    expect(left.textContent).not.toContain(zhTW.insights.cohort.inLoss);
    expect(right.textContent).toContain(`${100 - profit}% ${zhTW.insights.cohort.inLoss}`);
    expect(right.textContent).not.toContain(zhTW.insights.cohort.inProfit);
    // Money shares and wallet shares have different denominators.
    expect(left.querySelector(".text-positive")!.textContent).toBe("61.0%");
    expect(right.querySelector(".text-negative")!.textContent).toBe("39.0%");
  });

  it.each([55.5, 99.5])("the displayed whole-percent notional split still sums to 100 at %s percent long", (longPct) => {
    const full = wireOf("extremely_profitable");
    state.detail = { ...full, hero: { ...full.hero, longPct } };
    state.history = undefined;
    const html = render();
    const start = html.indexOf(">名目金額</h2>");
    const card = html.slice(start, html.indexOf("</section>", start));
    const displayedLong = Number(card.match(/(\d+)% 做多/)?.[1]);
    const displayedShort = Number(card.match(/(\d+)% 做空/)?.[1]);
    expect(displayedLong + displayedShort).toBe(100);
    expect(Math.abs(displayedLong - longPct)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(displayedShort - (100 - longPct))).toBeLessThanOrEqual(0.5);
  });

  it("an unknown notional split does not invent complementary percentages", () => {
    const full = wireOf("extremely_profitable");
    state.detail = { ...full, hero: { ...full.hero, longPct: null } };
    state.history = undefined;
    const html = render();
    const start = html.indexOf(">名目金額</h2>");
    const card = html.slice(start, html.indexOf("</section>", start));
    expect(card).not.toMatch(/\d+% 做(?:多|空)/);
  });

  it("an empty history explains the data requirement without promising a fixed refresh time", () => {
    state.detail = wireOf("rekt");
    state.history = { tier: "rekt", window: "all", series: [], btc: [] };
    const html = render();
    expect(html).toContain("歷史資料會在資料足夠後逐步累積。");
    expect(html).not.toContain("每 15 分鐘");
    expect(html).not.toContain("每 40 分鐘");
  });

  it("every language avoids the unsupported fixed-cadence promise in the empty history", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(catalog.insights.cohort.chartEmpty, locale).not.toMatch(/\{minutes\}|\b\d+\b/);
    }
  });

  it("a tier being built: the per-market map says so instead of an empty box, and its data shows its age", () => {
    state.detail = { ...wireOf("rekt"), updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() };
    state.history = { tier: "rekt", window: "all", series: [], btc: [] };
    const html = render();
    const map = html.slice(html.indexOf(zhTW.insights.cohort.byMarket));
    expect(map.slice(0, 900)).toContain(zhTW.insights.cohort.building);
    expect(map.slice(0, 900)).not.toContain("ui-skeleton");
    expect(html).toMatch(/data-testid="cohort-age">3 小時前</);
    expect(html).toContain("更新於 3 小時前");
    // Said once on the page, by the map; the pill's explanation waits for a press.
    expect(html.split("此分層的持倉資料尚未完整，背景持續更新中。</").length - 1).toBe(1);
    expect(html).not.toContain("第一次刷新約需數分鐘");
  });

  it("the window chips read 7天 / 30天 / 90天 / 全部, never 7d or all", () => {
    state.detail = wireOf("extremely_profitable");
    state.history = JSON.parse(JSON.stringify(cohortHistoryResponseSchema.parse(fixtureCohortHistory("extremely_profitable", "all"))));
    const html = render();
    for (const label of ["7天", "30天", "90天", "全部"]) expect(html).toContain(`>${label}</button>`);
    expect(html).not.toMatch(/>(7d|30d|90d|all)<\/button>/);
    expect(html).not.toMatch(/>all - /);
  });
});
