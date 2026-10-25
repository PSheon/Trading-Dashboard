// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CopyPanel } from "../src/components/trader/copy-panel";
import { I18nProvider } from "../src/i18n/provider";
import { catalogs } from "../src/i18n/messages";
import { LOCALES } from "../src/i18n/config";
import { SUGGESTED_BUDGET_DISPLAY_CAP_USD } from "../src/components/trader/suggested-budget-pill";

/**
 * Decisions D7/D9 (2026-10-23): the trader page's copy panel shows one pill
 * on its own line under the budget field, 建議 ≥ $X, from the profile's hourly figure. It turns
 * warning once the typed budget is under X; its one-sentence explanation is
 * in the hover tip only. No figure: no pill. Nothing else is added.
 */
const state = vi.hoisted(() => ({ suggested: 300 as number | null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/zh-TW/trader", useSearchParams: () => new URLSearchParams() }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", identity: "owner@email", login() {} }) }));
vi.mock("../src/lib/api", async () => ({ ...(await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api")), sessionKey: () => "1" }));
vi.mock("../src/lib/copy", () => ({
  useCopyOverview: () => ({ data: { paper: { balance: 1000 }, limits: { minAllocationUsd: 100, maxAllocationUsd: 5000, maxStrategies: 10 }, platform: { pauseNewRisk: false, reduceOnly: false }, user: { pauseNewRisk: false, reduceOnly: false }, strategies: [] } }),
  useCopyOf: () => undefined, useStartCopy: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../src/lib/copy-live-setup", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/copy-live-setup")>("../src/lib/copy-live-setup")),
  useLiveCopyAvailable: () => true,
  useLiveCopyDeployment: () => ({ network: "mainnet", available: true, sourceNetworks: ["mainnet"], caps: { fixedPerTradeUsd: null, maxAllocationUsd: 5000, maxLeverage: 3, maxStrategiesPerUser: 2, minBudgetUsd: 12 } }),
  useLiveCopySetup: () => ({ data: undefined, isError: false, walletError: null }),
  useLiveCopySetupActions: () => ({ start: { isPending: false, mutateAsync: vi.fn() }, confirm: { isPending: false }, restart: { isPending: false }, cancel: { isPending: false, mutate() {} } }),
}));
vi.mock("../src/lib/copy-live-portfolio", () => ({ useLiveCopyPortfolio: () => ({ data: { items: [] } }) }));
vi.mock("../src/lib/wallet", () => ({ useWallet: () => ({ data: { network: "mainnet", hyperliquid: { withdrawable: 1000 } } }), signErrorMessage: () => ({ rejected: false, message: "" }) }));
vi.mock("../src/lib/queries", () => ({ useLeaderCopyActivity: () => ({ data: undefined, isPending: false, refetch() {} }),
  useTraderProfile: () => ({ data: { suggestedMinBudgetUsd: state.suggested } }), useTraderFills: () => ({ data: undefined }), useSiteSettings: () => ({ data: { copyTradingEnabled: true } }) }));

const leader = `0x${"ab".repeat(20)}`;
const zh = catalogs["zh-TW"];
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); state.suggested = 300;
  localStorage.setItem("orbie:copy-mode:owner@email", "testnet");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); document.body.replaceChildren(); });
async function render(sheet = false) {
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={zh}><CopyPanel address={leader} sheet={sheet} /></I18nProvider>));
}
async function type(value: string) {
  const input = container.querySelector("input#copy-amount") as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
const pill = () => container.querySelector<HTMLElement>('[data-testid="copy-suggested-budget"]');

it("shows 建議 ≥ $300 under the budget, quiet until the typed budget is under it, warning then, quiet again at it", async () => {
  await render();
  expect(pill()!.closest('[data-testid="copy-suggested-line"]')).not.toBeNull();
  expect(pill()!.textContent).toContain("建議 ≥ $300");
  expect(pill()!.dataset.below).toBeUndefined();
  expect(pill()!.className).toContain("bg-raised");
  await type("100");
  expect(pill()!.dataset.below).toBe("true");
  expect(pill()!.className).toContain("bg-tag-warning");
  await type("300");
  expect(pill()!.dataset.below).toBeUndefined();
  await type("1200");
  expect(pill()!.dataset.below).toBeUndefined();
});

it("keeps the explanation in the hover tip only (an InfoTip button inside the pill), never as a sentence on the panel", async () => {
  await render();
  const tip = pill()!.querySelector("button")!;
  expect(tip.getAttribute("aria-label")).toBe(zh.common.moreInfo);
  const described = container.querySelector(`#${tip.getAttribute("aria-describedby")}`)!;
  expect(described.className).toContain("sr-only");
  expect(described.textContent).toBe(zh.trader.copy.suggestedMinTip);
  // The sentence occurs once in the whole panel: that hidden description.
  expect(container.innerHTML.split(zh.trader.copy.suggestedMinTip).length - 1).toBe(1);
});

it("without a figure there is no pill, and the panel is otherwise the same", async () => {
  await render();
  const withPill = container.innerHTML;
  state.suggested = null;
  await render();
  expect(pill()).toBeNull();
  expect(withPill).not.toBe(container.innerHTML);
  expect(withPill.replace(/<div data-testid="copy-suggested-line"[^>]*><span data-testid="copy-suggested-budget"[\s\S]*?<\/span><\/span><\/div>/, "")).toBe(container.innerHTML);
});

it("the phone sheet shows the same pill on its own line under the amount", async () => {
  await render(true);
  expect(pill()!.textContent).toContain("建議 ≥ $300");
  expect(pill()!.closest('[data-testid="copy-suggested-line"]')).not.toBeNull();
  expect(container.querySelector("#copy-amount-sheet")!.parentElement!.parentElement!.contains(pill())).toBe(false);
  expect(container.querySelector('[data-testid="copy-amount-row"]')).toBeNull();
});

/** QA on Stage, 2026-10-25: in the amount row the pill pushed 最大 past the
 * card's right edge at 1440 px. The row holds the amount, USDC and 最大 only;
 * the pill is the line right under it. */
it("keeps the amount row to the amount, USDC and 最大; the pill is the next line", async () => {
  await render();
  const row = container.querySelector<HTMLElement>('[data-testid="copy-amount-row"]')!;
  expect(row.contains(pill())).toBe(false);
  expect(row.querySelector("button")!.textContent).toBe(zh.trader.copy.max);
  expect(row.nextElementSibling!.getAttribute("data-testid")).toBe("copy-suggested-line");
  expect(row.nextElementSibling!.contains(pill())).toBe(true);
});

/** Stage showed 建議 ≥ $1,390,000 (huge equity ÷ a tiny median add). Above
 * SUGGESTED_BUDGET_DISPLAY_CAP_USD ($100k) no pill is drawn; at the cap it is. */
it("draws no pill for a suggestion above the $100k cap, and draws it at the cap", async () => {
  expect(SUGGESTED_BUDGET_DISPLAY_CAP_USD).toBe(100_000);
  state.suggested = 1_390_000;
  await render();
  expect(pill()).toBeNull();
  expect(container.querySelector('[data-testid="copy-suggested-line"]')).toBeNull();
  expect(container.textContent).not.toContain("1,390,000");
  state.suggested = 100_000;
  await render();
  expect(pill()!.textContent).toContain("建議 ≥ $100,000");
  state.suggested = 100_001;
  await render();
  expect(pill()).toBeNull();
});

it("every language has the pill text with its amount, and the one-sentence tip", () => {
  for (const locale of LOCALES) {
    const copy = catalogs[locale].trader.copy;
    expect(copy.suggestedMin, locale).toContain("{amount}");
    expect(copy.suggestedMin.trim().length, locale).toBeGreaterThan("{amount}".length);
    expect(copy.suggestedMinTip.trim(), locale).not.toBe("");
    expect(copy.suggestedMinTip, locale).toContain("30");
  }
});
