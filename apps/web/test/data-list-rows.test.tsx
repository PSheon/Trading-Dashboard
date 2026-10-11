// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityFeed } from "@/components/trader/live-feed";
import { TransferConfirm } from "@/components/copy/transfer-confirm";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import type { TraderFill, TraderTransfersResponse } from "@/lib/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
const reads = vi.hoisted(() => ({
  fills: { data: undefined as TraderFill[] | undefined, isError: false, isFetching: false, refetch: () => {} },
  transfers: { data: undefined as TraderTransfersResponse | undefined, isError: false, isFetching: false, refetch: () => {} },
}));
vi.mock("@/lib/queries", () => ({ useTraderFills: () => reads.fills, useTraderTransfers: () => reads.transfers }));

/** Every list of rows that is not a table goes through the one DataList, so
 * they share its 2 px dotted rule; no row draws its own border. */
const files = [
  "trader/live-feed.tsx", "trader/trade-analytics.tsx", "trader/mobile-insights.tsx",
  "admin/settings-form.tsx", "admin/trader-detail.tsx", "explore/boards-view.tsx",
  "settings/settings-view.tsx", "copy/copy-portfolio.tsx", "copy/transfer-confirm.tsx",
];
describe("row lists use DataList", () => {
  it.each(files)("%s has no hand-rolled row rules", (file) => {
    const src = readFileSync(join(process.cwd(), "src/components", file), "utf8");
    expect(src).toContain("<DataList");
    expect(src).not.toMatch(/<li\b[^>]*border-[bt]-2 border-dotted/);
    expect(src).not.toContain("last:border-0");
    expect(src).not.toMatch(/divide-y divide-border/);
    expect(src).not.toMatch(/Row className="border-b-2 border-dotted/);
    expect(src).not.toMatch(/<div\b[^>]*border-[bt]-2 border-dotted/);
  });
});

let root: Root, el: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  el = document.createElement("div"); document.body.append(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });

const isDataListRows = (node: Element | null) => {
  expect(node?.getAttribute("data-slot")).toBe("data-list");
  expect(node?.className).toContain("divide-y-2 divide-dotted divide-border");
};

it("the phone activity feed renders its rows in a DataList", async () => {
  reads.fills.data = [{ tid: "1", coin: "ETH", side: "buy", dir: "Open Long", px: 2500, sz: 1, notionalUsd: 2500, closedPnl: 0, fee: 0.1, ts: "2026-10-09T00:00:00Z" }];
  reads.transfers.data = { transfers: [], truncated: false, from: "2026-07-11T00:00:00Z", fetchedAt: "2026-10-09T00:00:00Z" };
  await act(async () => root.render(<I18nProvider locale="en" messages={en}><ActivityFeed address="0xabc" /></I18nProvider>));
  const li = el.querySelector("li");
  expect(li).not.toBeNull();
  isDataListRows(li!.parentElement);
  expect(li!.parentElement?.className).toContain("sm:hidden");
  expect(li!.className).not.toContain("border-b-2");
});

it("the transfer confirm sheet's facts use the dotted DataList rule", async () => {
  await act(async () => root.render(<I18nProvider locale="en" messages={en}>
    <TransferConfirm kind="returnAll" open amount="49 USDC" destination={`0x${"11".repeat(20)}`} network="testnet" pending={false} error={null} onConfirm={() => {}} onOpenChange={() => {}} />
  </I18nProvider>));
  const dl = document.querySelector('[data-testid="transfer-confirm"] dl');
  isDataListRows(dl);
  expect(dl?.tagName).toBe("DL");
});
