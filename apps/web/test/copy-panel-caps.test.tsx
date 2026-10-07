// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CopyPanel, copyAmountBounds } from "../src/components/trader/copy-panel";
import { I18nProvider } from "../src/i18n/provider";
import { catalogs } from "../src/i18n/messages";
import { ApiError } from "../src/lib/api";

/**
 * The trader panel on a live deployment (audit 2026-10-07 P0-1): 正式
 * takes the deployment's caps (Stage: 11–15 a trade, 50 at most a copy), not
 * the paper account's $100 floor; above the cap it says 上限 $50, and the
 * api's above_max_allocation names the same cap. 模擬 keeps the paper limits.
 */
const state = vi.hoisted(() => ({ start: vi.fn(), toasts: [] as string[], live: true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/zh-TW/trader", useSearchParams: () => new URLSearchParams() }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", identity: "owner@email", login() {} }) }));
vi.mock("../src/lib/api", async () => ({ ...(await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api")), sessionKey: () => "1" }));
vi.mock("../src/components/ui/toast", async () => {
  const push = (line: string) => { state.toasts.push(line); return 1; };
  return { ...(await vi.importActual<typeof import("../src/components/ui/toast")>("../src/components/ui/toast")), useToast: () => ({ error: push, info: push, success: push, warning: push, dismiss() {} }) };
});
vi.mock("../src/lib/copy", () => ({
  useCopyOverview: () => ({ data: { paper: { balance: 1000 }, limits: { minAllocationUsd: 100, maxAllocationUsd: 5000, maxStrategies: 10 }, platform: { pauseNewRisk: false, reduceOnly: false }, user: { pauseNewRisk: false, reduceOnly: false }, strategies: [] } }),
  useCopyOf: () => undefined, useStartCopy: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
const caps = { fixedPerTradeUsd: { min: 11, max: 15 }, maxAllocationUsd: 50, maxLeverage: 10, maxStrategiesPerUser: 2 };
vi.mock("../src/lib/copy-live-setup", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/copy-live-setup")>("../src/lib/copy-live-setup")),
  useLiveCopyAvailable: () => state.live,
  useLiveCopyDeployment: () => state.live ? { network: "mainnet", available: true, sourceNetworks: ["mainnet"], caps } : null,
  useLiveCopySetup: () => ({ data: undefined, isError: false, walletError: null }),
  useLiveCopySetupActions: () => ({ start: { isPending: false, mutateAsync: state.start }, confirm: { isPending: false }, restart: { isPending: false }, cancel: { isPending: false, mutate() {} } }),
}));
vi.mock("../src/lib/copy-live-portfolio", () => ({ useLiveCopyPortfolio: () => ({ data: { items: [] } }) }));
vi.mock("../src/lib/wallet", () => ({ useWallet: () => ({ data: { network: "mainnet", hyperliquid: { withdrawable: 180 } } }), signErrorMessage: () => ({ rejected: false, message: "" }) }));
vi.mock("../src/lib/queries", () => ({ useSiteSettings: () => ({ data: { copyTradingEnabled: true } }) }));

const leader = `0x${"ab".repeat(20)}`;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); state.toasts = []; state.live = true;
  localStorage.setItem("orbie:copy-mode:owner@email", "testnet");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); document.body.replaceChildren(); });
async function render(sheet = false) {
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={catalogs["zh-TW"]}><CopyPanel address={leader} sheet={sheet} /></I18nProvider>));
}
async function type(value: string, selector = "input#copy-amount") {
  const input = container.querySelector(selector) as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
const cta = () => container.querySelector('button[type="submit"]') as HTMLButtonElement;

it("正式 on a capped deployment: 5 is below its 11 minimum, 80 is above its 50 cap, 40 can start", async () => {
  await render();
  await type("5");
  expect(cta().textContent).toBe("最低 $11 才能跟單");
  await type("80");
  expect(cta().textContent).toBe("上限 $50");
  await act(async () => cta().click());
  expect(state.start).not.toHaveBeenCalled();
  expect(state.toasts).toEqual(["單一跟單最多 $50"]);
  await type("40");
  expect(cta().textContent).toContain("40");
  expect(cta().textContent).not.toContain("最低");
});

it("最大 stops at the cap, and the api's above_max_allocation names the deployment's cap, not the paper limit", async () => {
  await render();
  const max = [...container.querySelectorAll("button")].find((b) => b.textContent === "最大")!;
  await act(async () => max.click());
  expect((container.querySelector("input#copy-amount") as HTMLInputElement).value).toBe("50");
  await type("12", "input[placeholder='11–15']");
  state.start.mockRejectedValue(new ApiError(409, "Refused", { code: "above_max_allocation" }));
  await act(async () => cta().click());
  expect(state.start).toHaveBeenCalledOnce();
  expect(state.toasts.at(-1)).toBe("單一跟單最多 $50");
});

it("模擬 keeps the paper limits, and the phone sheet says 模擬 when only paper runs", async () => {
  localStorage.setItem("orbie:copy-mode:owner@email", "paper");
  await render();
  await type("80");
  expect(cta().textContent).toBe("最低 $100 才能跟單");
  state.live = false;
  await render(true);
  expect(container.querySelector("[data-testid='copy-mode-paper']")?.textContent).toContain("模擬");
  expect(container.querySelector("button[aria-label='Backspace']")).toBeNull();
  expect(container.querySelector("button[aria-label='刪除']")).toBeTruthy();
});

it("bounds: live from the caps (minimum 1 without a per-trade cap), paper from the paper limits", () => {
  expect(copyAmountBounds(true, { minAllocationUsd: 100, maxAllocationUsd: 5000 }, caps)).toEqual({ min: 11, max: 50 });
  expect(copyAmountBounds(true, undefined, { fixedPerTradeUsd: null, maxAllocationUsd: null })).toEqual({ min: 1, max: null });
  expect(copyAmountBounds(false, { minAllocationUsd: 100, maxAllocationUsd: 5000 }, caps)).toEqual({ min: 100, max: 5000 });
});

it("更多設定 is the shared Collapsible: closed it is inert and hidden from assistive technology, opened it is neither", async () => {
  await render();
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-controls="copy-more"]')!;
  const panel = container.querySelector<HTMLElement>("#copy-more")!;
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(panel.hasAttribute("inert")).toBe(true);
  expect(panel.getAttribute("aria-hidden")).toBe("true");
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(panel.hasAttribute("inert")).toBe(false);
  expect(panel.hasAttribute("aria-hidden")).toBe(false);
});
