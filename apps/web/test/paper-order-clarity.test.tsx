// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CopyDetail } from "@/components/copy/copy-portfolio";
import { fixtureCopyOverview } from "@/fixtures/copy";
import { I18nProvider } from "@/i18n/provider";
import { catalogs } from "@/i18n/messages";
import type { CopyOrderView, CopyStrategyView } from "@/lib/contracts";

const state = vi.hoisted(() => ({ desktop: true, orders: [] as Pick<CopyOrderView, "id" | "status" | "reason" | "filledSize" | "size" | "leg">[] }));
vi.mock("@/lib/use-is-desktop", () => ({ useIsDesktop: () => state.desktop }));
const idle = { mutateAsync: async () => ({}), isPending: false };
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/zh-TW/portfolio", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/copy", async () => ({ ...(await vi.importActual<typeof import("@/lib/copy")>("@/lib/copy")),
  useCopyCommand: () => idle, usePatchCopy: () => idle, useAddCopyFunds: () => idle, useWithdrawCopyFunds: () => ({ ...idle, pendingOperations: [] }),
  useCopyOrders: () => ({ data: { items: state.orders.map((order) => ({ coin: "ETH", side: "B", avgPx: null, createdAt: "2026-10-08T12:00:00Z", ...order })), hasMore: false }, isError: false }),
}));
vi.mock("@/components/copy/copy-compare", () => ({ CopyCompare: () => null }));
vi.mock("@/components/copy/copy-accounting-history", () => ({ CopyFundsRecords: () => null, OrderFills: () => <p data-testid="order-fills">成交明細</p> }));
vi.mock("@/lib/favorite-groups", () => ({ useTraderCards: () => ({ data: { items: [] } }) }));
vi.mock("@/components/copy/live-copy-setup-dialogs", () => ({ useCopyTexts: () => ({ live: { errors: {} }, extra: { codes: {} } }) }));
vi.mock("@/lib/site-mode", () => ({ useSiteMode: () => "paper", useTradingMode: () => ({ mode: "paper", select: () => false }) }));
let root: Root, container: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.desktop = true; state.orders = []; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.replaceChildren(); });
async function renderOrders() {
  const strategy = fixtureCopyOverview().strategies[0]! as unknown as CopyStrategyView;
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={catalogs["zh-TW"]}><CopyDetail strategy={strategy} leader={{ address: strategy.leaderAddress, displayName: "Kinetiq", avatarUrl: null }} balance={1000} onBack={() => {}} /></I18nProvider>));
  return [...container.querySelectorAll('[data-testid="paper-orders"] tbody > tr')];
}
function order(reason: string | null, status: CopyOrderView["status"] = "rejected", filledSize = 0) {
  return { id: String(state.orders.length + 1), reason, status, filledSize, size: 0.0046, leg: "open" as const };
}
it("localizes risk refusal and stale signal without presenting them as execution failures", async () => {
  state.orders = [order("platform_paused"), { ...order("stale_signal_before_fill", "cancelled"), id: "2" }];
  const rows = await renderOrders();
  expect(rows[0].textContent).toContain("風控未執行");
  expect(rows[0].textContent).toContain("平台已暫停新風險");
  expect(rows[1].textContent).toContain("信號已超過時效");
  expect(rows[0].querySelector(".text-negative")).toBeNull();
  expect(rows[1].querySelector(".text-negative")).toBeNull();
});
it("keeps partial fills visible when a later risk check cancels the remainder", async () => {
  state.orders = [order("platform_paused_before_fill", "cancelled", 0.002)];
  const [row] = await renderOrders();
  expect(row.textContent).toContain("平台已暫停新風險");
  expect(row.textContent).not.toContain("風控未執行");
  expect(row.textContent).toContain("0.002");
});
it("uses a conservative localized fallback for unknown reasons and retains a failure tone", async () => {
  state.orders = [order("unrecognized_server_detail")];
  const [row] = await renderOrders();
  expect(row.textContent).toContain("原因尚未確認");
  expect(row.textContent).not.toContain("unrecognized");
  expect(row.querySelector(".text-negative")).not.toBeNull();
});
it("preserves partial-fill status and localizes its remaining-order reason", async () => {
  state.orders = [order("frequency", "partial", 0.002)];
  const [row] = await renderOrders();
  expect(row.textContent).toContain("部分成交");
  expect(row.textContent).toContain("超過每分鐘下單數");
  expect(row.textContent).not.toContain("風控未執行");
});
it("does not translate unknown codes through inherited command properties", async () => {
  state.orders = [order("platform_constructor")];
  const [row] = await renderOrders();
  expect(row.textContent).toContain("原因尚未確認");
  expect(row.textContent).not.toContain("copyAdmin.");
});
it("keeps actual-copy minimum-order rules out of the paper table and does not invent fill reasons", async () => {
  state.orders = [{ ...order("platform_paused", "filled", 0.0046), leg: "close" }];
  const [row] = await renderOrders();
  expect(container.textContent).not.toContain("減倉金額低於最小下單金額時，可能放大減倉或改為全平倉");
  expect(row.textContent).not.toContain("平台已暫停");
  expect(row.textContent).not.toContain("低於最小下單金額");
});

it("shows mobile order status and reason before expanding complete order details", async () => {
  state.desktop = false;
  state.orders = [order("platform_paused"), { ...order("frequency", "partial", 0.002), id: "2" }];
  await renderOrders();
  const list = container.querySelector('[data-testid="paper-orders-mobile"]');
  expect(list).not.toBeNull();
  expect(container.querySelector('[data-testid="paper-orders"]')).toBeNull();
  const rows = [...list!.querySelectorAll("li")];
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("ETH");
  expect(rows[0].textContent).toContain("風控未執行");
  expect(rows[0].textContent).toContain("平台已暫停新風險");
  expect(rows[1].textContent).toContain("部分成交");
  expect(rows[1].textContent).toContain("超過每分鐘下單數");
  const toggle = rows[1].querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(rows[1].querySelector("dl")).toBeNull();
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const details = rows[1].querySelector("dl")!;
  expect(details.textContent).toContain("時間");
  expect(details.textContent).toContain("數量");
  expect(details.textContent).toContain("0.002");
  expect(details.textContent).toContain("成交價");
  expect(rows[1].textContent).toContain("成交明細");
  expect(container.querySelectorAll('[data-testid="order-fills"]')).toHaveLength(1);
  await act(async () => toggle.click());
  expect(rows[1].querySelector("dl")).toBeNull();
});
