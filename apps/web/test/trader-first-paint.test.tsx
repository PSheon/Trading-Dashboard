import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { TraderView } from "../src/components/trader/trader-view";
import { ActivityTabs } from "../src/components/trader/activity-tabs";
import type { TraderProfileResponse } from "../src/lib/contracts";

/**
 * Stage, 2026-10-05: a cold trader page asked for its activity and its
 * 2,000 fills (Hyperliquid's two fill lists, ≈ 240 weight on the api)
 * alongside the profile and the chart, and the first paint waited behind
 * them for 10–30 s. They are asked for once the first paint is in.
 */
const state = vi.hoisted(() => ({
  profile: undefined as unknown,
  portfolio: { data: undefined as unknown, errorUpdateCount: 0, isPending: true },
  activityEnabled: [] as boolean[],
  fillsEnabled: [] as boolean[],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }), notFound: () => { throw new Error("notFound"); } }));
vi.mock("../src/lib/queries", () => ({
  useTraderProfile: () => ({ data: state.profile, errorUpdateCount: 0, refetch() {} }),
  isComputing: () => false,
  useTraderAnalytics: () => ({ data: undefined }),
  useTraderActivity: (_address: string, _initial: unknown, options: { enabled?: boolean } = {}) => {
    state.activityEnabled.push(options.enabled ?? true);
    return { data: undefined, isError: false };
  },
  useTraderFills: (_address: string, _limit: number, options: { enabled?: boolean } = {}) => {
    state.fillsEnabled.push(options.enabled ?? true);
    return { data: undefined, isError: false };
  },
  useCopyScore: () => ({ data: undefined }),
  usePortfolio: () => state.portfolio,
  useSiteSettings: () => ({ data: undefined }),
  useChartSnapshots: () => ({ data: undefined }),
}));
vi.mock("../src/lib/use-live-trader", () => ({ useLiveTrader: (_a: string, profile: unknown) => ({ profile, fills: [], mids: {} }) }));
vi.mock("../src/components/trader/profile-card", () => ({ ProfileCard: () => null, ProfileCardSkeleton: () => null }));
vi.mock("../src/components/trader/copy-panel", () => ({ CopyPanel: () => <button data-testid="start-copy">Start copying</button> }));

const address = `0x${"ab".repeat(20)}`;
const known = { address, stats: { displayName: null }, positions: [], spotBalances: [], kol: null, analytics: null, isVault: false, tracked: false,
  accountValue: 1_000_000, stakedValue: null, dataQuality: { partial: false, sources: {} } } as unknown as TraderProfileResponse;
const blank = { ...known, stats: null, accountValue: 0 } as unknown as TraderProfileResponse;
const render = () => renderToStaticMarkup(<I18nProvider locale="en" messages={en}><TraderView address={address} /></I18nProvider>);

beforeEach(() => {
  state.activityEnabled = [];
  state.fillsEnabled = [];
  state.portfolio = { data: undefined, errorUpdateCount: 0, isPending: true };
});

describe("the trader page asks for the fill lists after its first paint", () => {
  it("not while the profile or the chart is still loading", () => {
    state.profile = undefined;
    render();
    state.profile = known;
    render();
    expect(state.activityEnabled).toEqual([false, false]);
  });

  it("once the profile and the chart are in, or the chart has failed", () => {
    state.profile = known;
    state.portfolio = { data: { pnl: [] }, errorUpdateCount: 0, isPending: false };
    render();
    state.portfolio = { data: undefined, errorUpdateCount: 1, isPending: true };
    render();
    expect(state.activityEnabled).toEqual([true, true]);
  });

  it("at once for a blank profile: only its fills tell a 404 from a quiet account", () => {
    state.profile = blank;
    render();
    expect(state.activityEnabled).toEqual([true]);
  });

  it("the tabs ask for no fill list until 動態 is opened (no fills tab any more)", () => {
    renderToStaticMarkup(<I18nProvider locale="en" messages={en}><ActivityTabs profile={known} /></I18nProvider>);
    render();
    expect(state.fillsEnabled).toEqual([]);
  });
});

it("does not admit a copy from the loading layout that will be replaced after hydration", () => {
  state.profile = undefined;
  expect(render()).not.toContain("start-copy");
  state.profile = known;
  expect(render()).not.toContain("start-copy");
});
