import { COHORT_HEADLINE_MIN_COVERAGE, cohortDetailResponseSchema, cohortHeadlineReady, cohortHistoryResponseSchema, wireCohortDetailSchema } from "@trading-dashboard/shared/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { InsightsView } from "../src/components/insights/insights-view";
import { fixtureCohort, fixtureCohortHistory } from "../src/fixtures/discovery";
import { zhTW } from "../src/i18n/messages/zh-TW";
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

  it("a tier read to 33 of 150 shows no headline figure: the cards are placeholders and the page says it is building", () => {
    state.detail = wireOf("rekt");
    state.history = { tier: "rekt", window: "all", series: [], btc: [] };
    const html = render();
    expect(state.detail).toMatchObject({ walletCount: 33, memberCount: 150, headlineReady: false, hero: { longPct: 6.9 } });
    // Neither split card is drawn (their titles are gone with them), so the
    // partial read's "7% 做多" is nowhere; the per-market map waits as well.
    expect(html).not.toContain(zhTW.insights.cohort.notional);
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
