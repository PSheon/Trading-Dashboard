// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CopyFollowerActivity } from "@/components/copy/copy-follower-activity";
import { CopyCompare } from "@/components/copy/copy-compare";
import { TraderSearchResults } from "@/components/explore/trader-search-results";
import { fixtureCopyOverview } from "@/fixtures/copy";
import { catalogs } from "@/i18n/messages";
import { zhTW } from "@/i18n/messages/zh-TW";
import { I18nProvider } from "@/i18n/provider";
import type { CopyExecutionAccount, CopyStrategyView } from "@/lib/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/explore" }));
vi.mock("@/lib/copy", () => ({ useCopyPerformance: () => ({ data: undefined, isPending: false, isError: false }) }));
vi.mock("@/lib/queries", () => ({ usePortfolio: () => ({ data: undefined, isPending: false, isError: false }) }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", mode: "privy", identity: "alice", wallet: { address: `0x${"11".repeat(20)}` } }) }));
vi.mock("@/lib/copy-follower-activity", () => ({ useCopyFollowerActivity: () => ({ isPending: true, isError: false, data: undefined }) }));

/** The long sentences the 2026-10-25 sweep found in the signed-in pages are
 * the ⓘ's beside their headings, or gone (Paul: the UI stays minimal). */
const parse = (node: React.ReactNode) => new DOMParser().parseFromString(
  renderToString(<QueryClientProvider client={new QueryClient()}><I18nProvider locale="zh-TW" messages={zhTW}>{node}</I18nProvider></QueryClientProvider>), "text/html");
const visible = (doc: Document) => {
  const body = doc.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll(".sr-only").forEach((n) => n.remove());
  return body.textContent ?? "";
};
const tipText = (doc: Document, near: Element) => {
  const tip = near.querySelector<HTMLButtonElement>(`button[aria-label="${zhTW.common.moreInfo}"]`)!;
  return doc.getElementById(tip.getAttribute("aria-describedby")!)!.textContent;
};

describe("sweep of long visible sentences", () => {
  it("a copy's compare card: the ROI definition is the ⓘ of its 同期 line", () => {
    const doc = parse(<CopyCompare strategy={fixtureCopyOverview().strategies[0]! as unknown as CopyStrategyView} traderName="Test trader" />);
    expect(visible(doc)).not.toContain(zhTW.pf.detail.note);
    const line = doc.querySelector('[data-testid="copy-compare"] p')!;
    expect(tipText(doc, line)).toBe(zhTW.pf.detail.note);
  });

  it("explore's address search: what it covers is the ⓘ of its title", () => {
    const doc = parse(<TraderSearchResults query="alice" />);
    expect(visible(doc)).not.toContain(zhTW.research.searchHint);
    const title = doc.getElementById("trader-search-title")!;
    expect(tipText(doc, title.parentElement!)).toBe(zhTW.research.searchHint);
  });

  it("a live copy's booked history: both reading notes are the ⓘ of its title", () => {
    const account = { id: "acct-1", strategyId: 1, network: "mainnet", state: "ready", address: `0x${"22".repeat(20)}`, automaticReturn: false } as unknown as CopyExecutionAccount;
    const doc = parse(<CopyFollowerActivity account={account} />);
    const text = visible(doc);
    expect(text).not.toContain(zhTW.copyFollowerStatement.deltaHint);
    expect(text).not.toContain(zhTW.copyFollowerActivity.hint);
    expect(tipText(doc, doc.querySelector("h4")!)).toBe(zhTW.copyFollowerActivity.hint + zhTW.copyFollowerStatement.deltaHint);
  });

  it("an empty TWAP tab is its title only; the sentence is gone from every catalog", () => {
    expect(readFileSync("src/components/trader/trader-tabs.tsx", "utf8")).not.toContain("twapDesc");
    for (const [locale, catalog] of Object.entries(catalogs)) expect(catalog.trader.empty, locale).not.toHaveProperty("twapDesc");
  });
});
