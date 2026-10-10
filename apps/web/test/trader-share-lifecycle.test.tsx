// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { TraderView } from "../src/components/trader/trader-view";
import type { TraderProfileResponse } from "../src/lib/contracts";
const state = vi.hoisted(() => ({
  profile: undefined as unknown,
  desktop: undefined as boolean | undefined,
  portfolio: { data: undefined as unknown, errorUpdateCount: 0, isPending: true },
  activityEnabled: [] as boolean[],
  fillsEnabled: [] as boolean[],
}));
vi.mock("../src/lib/use-is-desktop", () => ({ useIsDesktop: () => state.desktop }));
vi.mock("../src/components/section-boundary", () => ({ SectionBoundary: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../src/components/trader/performance", () => ({ KpiTiles: () => null, PerformanceChart: () => null, windowRoi: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }), notFound: () => { throw new Error("notFound"); } }));
vi.mock("../src/lib/queries", () => ({
  useTraderProfile: () => ({ data: state.profile, errorUpdateCount: 0, refetch() {} }),
  isComputing: () => false,
  isUnavailable: () => false,
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
vi.mock("../src/components/trader/trader-copy-flow", () => ({ TraderCopyFlow: ({ children }: { children: React.ReactNode }) => children }));


vi.mock("../src/components/ui/toast",()=>({useToast:()=>({success(){},error(){}})}));
vi.mock("../src/components/trader/activity-tabs",async()=>{const {PositionsTab}=await import("../src/components/trader/trader-tabs");return {ActivityTabs:PositionsTab,ActivityTabsSkeleton:()=>null};});
vi.mock("../src/components/trader/mobile-trader",async()=>{const {PositionsTab}=await import("../src/components/trader/trader-tabs");return {MobileTrader:PositionsTab,MobileTraderSkeleton:()=>null};});

it("keeps the same share dialog and chosen format across responsive layout replacement, but closes on leader change",async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  const address='0x'+'ab'.repeat(20),other='0x'+'cd'.repeat(20);
  state.profile={address,stats:{displayName:'Trader'},positions:[{coin:'BTC',szi:1,entryPx:100,positionValue:120,unrealizedPnl:20,leverage:2,marginUsed:50,liqPx:40}],spotBalances:[],kol:null,analytics:null,isVault:false,tracked:false,accountValue:1000,perpEquity:1000,stakedValue:null,dataQuality:{partial:false,sources:{}}} as unknown as TraderProfileResponse;
  state.portfolio={data:{pnl:[]},errorUpdateCount:0,isPending:false};state.desktop=true;
  const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
  const render=(leader=address)=>act(async()=>root.render(<I18nProvider locale="en" messages={en}><TraderView address={leader}/></I18nProvider>));
  try {
    await render();
    await act(async()=>el.querySelector<HTMLButtonElement>('button[aria-label="Share position"]')!.click());
    const dialog=document.querySelector('[role="dialog"]');expect(dialog).not.toBeNull();
    await act(async()=>document.querySelector<HTMLButtonElement>('button[aria-label="Poster · 4:5"]')!.click());
    state.desktop=false;await render();expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    state.desktop=true;await render();expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(document.querySelector('button[aria-label="Poster · 4:5"]')?.getAttribute('aria-checked')).toBe('true');
    await render(other);expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {await act(async()=>root.unmount());el.remove();localStorage.clear();}
});
