// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PortfolioView } from "@/components/portfolio-view";
import { zhTW } from "@/i18n/messages/zh-TW";
import { I18nProvider } from "@/i18n/provider";

/** The portfolio's empty states stay minimal (Paul, 2026-10-25): a short
 * title and the 尋找交易員 button, no sentence; an empty 跟單動態 is a muted
 * dash with its hint on hover. */
const state = vi.hoisted(() => ({ mode: "testnet" as "testnet" | "paper" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => "/portfolio", useRouter: () => ({ push() {}, replace() {} }) }));
vi.mock("@/i18n/navigation", () => ({ Link: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", login() {} }) }));
vi.mock("@/lib/site-mode", () => ({
  useSiteMode: () => "testnet",
  useTradingMode: () => ({ mode: state.mode, select: () => true, deploymentNetwork: "testnet", pending: false }),
}));
vi.mock("@/lib/copy-live-setup", () => ({ useLiveCopyDeployment: () => ({ available: true, network: "testnet", inviteOnly: false }) }));
vi.mock("@/lib/copy-live-portfolio", () => ({ useLiveCopyPortfolio: () => ({ data: { items: [] } }) }));
vi.mock("@/lib/copy-equity", () => ({ CopyEquityProbes: () => null, useCopiesEquity: () => 0 }));
vi.mock("@/lib/wallet", () => ({ useWallet: () => ({ data: undefined, isError: false, refetch() {} }) }));
vi.mock("@/lib/copy", () => ({
  useCopyEvents: () => ({ data: { items: [], hasMore: false }, isPending: false, isLoadingOlder: false, loadOlder() {} }),
  useCopyOverview: () => ({ data: { strategies: [], paper: { balance: 10_000, totalValue: 10_000 } }, isError: false, refetch() {} }),
  useCopyPortfolio: () => ({ data: undefined }),
}));
vi.mock("@/components/copy/live-copies", () => ({ LiveCopies: ({ empty }: { empty: React.ReactNode }) => <>{empty}</> }));
vi.mock("@/components/copy/copy-portfolio", () => ({ CopyCards: () => null, CopyDetail: () => null, CopyListSkeleton: () => null, CopyTable: () => null, useLeaders: () => new Map() }));
vi.mock("@/components/copy/portfolio-parts", () => ({ ExposurePanel: () => null, InsightsPanel: () => null, PaperSummary: () => null, PaperSummarySkeleton: () => null, PortfolioChart: () => null, PortfolioChartSkeleton: () => null }));
vi.mock("@/components/copy/activity-panel", () => ({ ActivityPanel: () => null }));
vi.mock("@/components/wallet/wallet-modals", () => ({ useWalletModals: () => ({ openDeposit() {}, openWithdraw() {} }) }));

let root: Root;
let host: HTMLDivElement;
async function render() { await act(async () => root.render(<I18nProvider locale="zh-TW" messages={zhTW}><PortfolioView /></I18nProvider>)); }
/** Visible paragraphs that are sentences (screen-reader-only text aside). */
const sentences = (el: Element) => [...el.querySelectorAll("p")].map((p) => {
  const copy = p.cloneNode(true) as Element;
  copy.querySelectorAll(".sr-only").forEach((n) => n.remove());
  return copy.textContent ?? "";
}).filter((text) => /[。，]/.test(text));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.mode = "testnet";
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("portfolio empty states", () => {
  it("real: 還沒有跟單 as a heading and 尋找交易員, no sentence; 跟單動態 empty is a dash with the hint on hover", async () => {
    await render();
    const empty = host.querySelector('[data-testid="no-copies"]')!;
    expect(empty.querySelector("h2")!.textContent).toBe(zhTW.folio.emptyTitle);
    expect(empty.querySelector("a")!.textContent).toBe(zhTW.folio.find);
    expect(empty.querySelectorAll("p")).toHaveLength(0);
    const activity = host.querySelector('[data-testid="copy-activity-empty"]')!;
    expect(activity.getAttribute("title")).toBe(zhTW.folio.noCopyActivity);
    expect(activity.querySelector('[aria-hidden]')!.textContent).toBe("—");
    expect(sentences(host)).toEqual([]);
  });

  it("paper: the empty copying and insights tabs are an icon and a title", async () => {
    state.mode = "paper";
    await render();
    const empties = [...host.querySelectorAll('[data-testid="tab-empty"]')];
    expect(empties.length).toBeGreaterThan(0);
    for (const empty of empties) {
      expect(empty.querySelector("h2")!.textContent).toBe(zhTW.portfolio.emptyTitle);
      expect(empty.querySelectorAll("p")).toHaveLength(0);
    }
    const insights = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === zhTW.portfolio.tabs.insights)!;
    await act(async () => insights.click());
    const tab = [...host.querySelectorAll('[data-testid="tab-empty"]')].find((el) => el.textContent === zhTW.portfolio.insightsEmptyTitle)!;
    expect(tab.querySelectorAll("p")).toHaveLength(0);
    expect(sentences(host)).toEqual([]);
  });

  it("every button on the page has an accessible name", async () => {
    for (const mode of ["testnet", "paper"] as const) {
      state.mode = mode;
      await render();
      const unnamed = [...host.querySelectorAll("button")].filter((b) => !(b.getAttribute("aria-label") || b.textContent?.trim() || b.getAttribute("aria-labelledby")));
      expect(unnamed.map((b) => b.outerHTML), mode).toEqual([]);
    }
  });
});
