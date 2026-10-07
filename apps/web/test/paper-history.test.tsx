// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CopyFundsRecords, OrderFills } from "../src/components/copy/copy-accounting-history";
import { I18nProvider } from "../src/i18n/provider";
import { zhTW } from "../src/i18n/messages/zh-TW";

/**
 * B9 (Paul, 2026-10-07, audit §十三): 模擬訂單 and 模擬帳戶歷史 are one
 * history: 訂單 (a row opens its fills with the order's fees and realized
 * PnL) and 資金紀錄 (the ledger rows of no order). No raw decimals or ids.
 */
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 7, 10) - minutes * 60_000).toISOString();
const fill = (id: number, orderId: number, over: Record<string, string> = {}) => ({ id: String(id), orderId: String(orderId), coin: "ETH", side: "B", size: "0.01000000", px: "2500.123400", fee: "0.010000", builderFee: "0.000000", realizedPnl: "0.000000", ts: at(id), ...over });
const ledger = (id: number, kind: string, amount: string, orderId: number | null, coin: string | null = null) => ({ id: String(id), kind, amount, coin, orderId: orderId === null ? null : String(orderId), createdAt: at(id) });
const pages: Record<string, Array<{ items: unknown[]; previousCursor: string | null; hasMore: boolean }>> = {};
const calls: string[] = [];
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", mode: "privy", identity: "a@example.com" }) }));
vi.mock("../src/lib/api", async (original) => {
  const actual = await original<typeof import("../src/lib/api")>();
  return { ...actual, sessionKey: () => "1", api: { get: async (path: string) => {
    calls.push(path);
    const kind = path.includes("/fills") ? "fills" : "ledger";
    const before = new URL(`http://x${path}`).searchParams.get("before");
    const list = pages[kind]!;
    const index = before ? list.findIndex((p, i) => i > 0 && list[i - 1]!.previousCursor === before) : 0;
    return { mode: "paper", ...list[Math.max(0, index)]! };
  } } };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, el: HTMLDivElement;
beforeEach(() => { calls.length = 0; el = document.createElement("div"); document.body.append(el); root = createRoot(el); });
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });
const render = async (node: React.ReactNode) => {
  await act(async () => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider locale="zh-TW" messages={zhTW}>{node}</I18nProvider></QueryClientProvider>));
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
};

describe("訂單: an order's row opens its fills", () => {
  it("lists that order's fills only, with its fees and realized PnL, reading older pages until past the order", async () => {
    // Newest first: order 9's fills are on the first page, order 3's on the second.
    pages.fills = [
      { items: [fill(20, 9, { realizedPnl: "1.500000" }), fill(19, 9, { fee: "0.020000", builderFee: "0.010000", realizedPnl: "-0.250000" }), fill(18, 8)], previousCursor: "18", hasMore: true },
      { items: [fill(17, 3, { size: "0.50000000" }), fill(16, 2)], previousCursor: "16", hasMore: false },
    ];
    await render(<OrderFills strategyId={7} orderId="9" />);
    const box = el.querySelector('[data-testid="order-fills"]')!;
    expect(box.querySelector('[data-slot="data-list"]')).not.toBeNull();
    expect(box.querySelectorAll("li")).toHaveLength(2);
    expect(box.textContent).toContain("手續費-$0.04");
    expect(box.textContent).toContain("已實現損益+$1.25");
    expect(calls).toEqual(["/me/copy/strategies/7/fills?limit=100"]);
    await render(<OrderFills strategyId={7} orderId="3" />);
    expect(calls).toContain("/me/copy/strategies/7/fills?limit=100&before=18");
    expect(el.querySelector('[data-testid="order-fills"]')!.querySelectorAll("li")).toHaveLength(1);
    expect(el.textContent).toContain("0.5 × $2,500.12");
    expect(el.textContent).not.toMatch(/#\d|2500\.123400/);
  });
});

describe("資金紀錄", () => {
  it("is the ledger rows of no order, formatted, ten a page, no ids or raw decimals", async () => {
    pages.ledger = [{
      items: [
        ...Array.from({ length: 12 }, (_, i) => ledger(100 - i, "funding", "-0.012345", null, "ETH")),
        ledger(80, "realized_pnl", "1.500000", 9), ledger(79, "fee", "-0.010000", 9),
        ledger(78, "allocate", "150.000000", null),
      ],
      previousCursor: null, hasMore: false,
    }];
    await render(<CopyFundsRecords strategyId={7} />);
    const card = el.querySelector('[data-testid="copy-funds-records"]')!;
    expect(card.querySelector("h3")!.textContent).toBe("資金紀錄");
    expect(card.querySelectorAll("li")).toHaveLength(10);
    expect(card.textContent).toContain("資金費 · ETH");
    expect(card.textContent).toContain("-$0.01");
    expect(card.textContent).not.toMatch(/#\d|0\.012345|已實現損益|交易手續費/);
    expect(card.querySelector("[data-pager]")!.textContent).toContain("第 1 頁");
    const next = [...card.querySelectorAll<HTMLButtonElement>("[data-pager] button")].at(-1)!;
    await act(async () => next.click());
    expect([...card.querySelectorAll("li")].map((li) => li.textContent)).toEqual([expect.stringContaining("資金費"), expect.stringContaining("資金費"), expect.stringContaining("資金分配")]);
    expect(card.textContent).toContain("+$150.00");
  });
});
