// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CopyDetail } from "@/components/copy/copy-portfolio";
import { fixtureCopyOverview } from "@/fixtures/copy";
import { I18nProvider } from "@/i18n/provider";
import { catalogs } from "@/i18n/messages";
import type { CopyStrategyView } from "@/lib/contracts";

/**
 * The paper copy's 編輯設定 (audit 2026-10-07 P1-10): the cap is 最大曝險
 * (all its positions together), not 「最大分配額 $750」 beside the paper
 * balance; the copy's own money is said apart from it.
 */
const idle = { mutate() {}, mutateAsync: async () => ({}), isPending: false, isError: false };
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/zh-TW/portfolio", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/copy", async () => ({ ...(await vi.importActual<typeof import("@/lib/copy")>("@/lib/copy")),
  useCopyCommand: () => idle, usePatchCopy: () => idle, useAddCopyFunds: () => idle, useWithdrawCopyFunds: () => ({ ...idle, pendingOperations: [] }), useCopyOrders: () => ({ data: { items: [], nextCursor: null }, isPending: false }) }));
vi.mock("@/components/copy/copy-compare", () => ({ CopyCompare: () => null }));
vi.mock("@/components/copy/copy-accounting-history", () => ({ CopyFundsRecords: () => null, OrderFills: ({ orderId }: { orderId: string }) => <p data-testid="order-fills">fills of {orderId}</p> }));
vi.mock("@/lib/favorite-groups", () => ({ useTraderCards: () => ({ data: { items: [] } }) }));
vi.mock("@/components/copy/live-copy-setup-dialogs", () => ({ useCopyTexts: () => ({ live: { errors: {} }, extra: { codes: {} } }) }));
vi.mock("@/lib/site-mode", () => ({ useSiteMode: () => "paper", useTradingMode: () => ({ mode: "paper", select: () => false }) }));

let root: Root, container: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("says 最大曝險 in the settings and the edit dialog, with the copy's budget beside it, never 最大分配額", async () => {
  const strategy = { ...fixtureCopyOverview().strategies[0]!, status: "active" as const, allocated: 150, settings: { ...fixtureCopyOverview().strategies[0]!.settings, maxTotalExposureUsd: null } } as unknown as CopyStrategyView;
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={catalogs["zh-TW"]}><CopyDetail strategy={strategy} leader={{ address: strategy.leaderAddress, displayName: "Kinetiq", avatarUrl: null }} balance={9848.49} onBack={() => {}} /></I18nProvider>));
  expect(container.textContent).toContain("最大曝險$750.00");
  const edit = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("編輯設定"))!;
  await act(async () => edit.click());
  const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!;
  expect(dialog.textContent).toContain("最大曝險");
  expect(dialog.querySelector('[data-testid="edit-budget"]')!.textContent).toBe("跟單資金 $150");
  expect(dialog.textContent).not.toContain("最大分配額");
  expect(dialog.textContent).not.toContain("可用 $9,848.49");
  expect((dialog.querySelector("input#edit-max") as HTMLInputElement).value).toBe("750");
});
