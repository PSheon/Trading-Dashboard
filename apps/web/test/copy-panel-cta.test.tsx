// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CopyPanel } from "../src/components/trader/copy-panel";
import { I18nProvider } from "../src/i18n/provider";
import { catalogs } from "../src/i18n/messages";

/**
 * Copy panel CTA (2026-10-23): the amount starts at 0 and the primary button
 * read 請輸入金額, then 最低 $100 才能跟單, then 開始跟單 $X. It now always reads
 * 跟單 and is disabled until the amount is valid; what is wrong with the
 * amount is a pill under the field (the suggested-minimum pill's style),
 * never a sentence.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/zh-TW/trader", useSearchParams: () => new URLSearchParams() }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", identity: "owner@email", login() {} }) }));
vi.mock("../src/lib/api", async () => ({ ...(await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api")), sessionKey: () => "1" }));
const started = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../src/lib/copy", () => ({
  useCopyOverview: () => ({ data: { paper: { balance: 1000 }, limits: { minAllocationUsd: 100, maxAllocationUsd: 5000, maxStrategies: 10 }, platform: { pauseNewRisk: false, reduceOnly: false }, user: { pauseNewRisk: false, reduceOnly: false }, strategies: [] } }),
  useCopyOf: () => undefined, useStartCopy: () => ({ mutateAsync: started.start, isPending: false }),
}));
vi.mock("../src/lib/copy-live-setup", () => ({ useLiveCopyAvailable: () => false, useLiveCopyDeployment: () => null, setupTerminal: () => false, liveSetupScope: () => null, useLiveCopySetup: () => ({ data: undefined }),
  useLiveCopySetupActions: () => ({ start: { isPending: false }, confirm: { isPending: false }, restart: { isPending: false }, cancel: { isPending: false } }) }));
vi.mock("../src/lib/copy-live-portfolio", () => ({ useLiveCopyPortfolio: () => ({ data: undefined }) }));
vi.mock("../src/lib/wallet", () => ({ useWallet: () => ({ data: undefined }), signErrorMessage: () => ({ rejected: false, message: "" }) }));
vi.mock("../src/lib/queries", () => ({ useLeaderCopyActivity: () => ({ data: undefined, isPending: false, refetch() {} }),
  useTraderProfile: () => ({ data: { suggestedMinBudgetUsd: 300 } }), useTraderFills: () => ({ data: undefined }), useSiteSettings: () => ({ data: { copyTradingEnabled: true } }) }));

const zh = catalogs["zh-TW"];
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  started.start.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); document.body.replaceChildren(); });
async function render() {
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={zh}><CopyPanel address={`0x${"ab".repeat(20)}`} /></I18nProvider>));
}
async function type(value: string) {
  const input = container.querySelector("input#copy-amount") as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
const cta = () => container.querySelector('button[type="submit"]') as HTMLButtonElement;
const pill = () => container.querySelector<HTMLElement>('[data-testid="copy-amount-state"]');

it("reads 跟單 and is disabled at 0; enabled at a valid amount", async () => {
  await render();
  expect(cta().textContent).toBe("跟單");
  expect(cta().disabled).toBe(true);
  expect(pill()).toBeNull();
  await type("500");
  expect(cta().textContent).toBe("跟單");
  expect(cta().disabled).toBe(false);
  expect(pill()).toBeNull();
});

it("says what is wrong with the amount in a pill under the field, in the suggested-minimum pill's style, and never in the button", async () => {
  await render();
  const field = container.querySelector('[data-testid="copy-amount-row"]')!;
  await type("80");
  expect(cta().textContent).toBe("跟單");
  expect(cta().disabled).toBe(true);
  expect(pill()!.textContent).toBe("最低 $100 才能跟單");
  expect(pill()!.className).toContain("chip-sm");
  expect(pill()!.className).toContain("bg-tag-warning");
  expect(field.contains(pill())).toBe(false);
  expect(field.compareDocumentPosition(pill()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await type("6000");
  expect(pill()!.textContent).toBe("上限 $5,000");
  await type("1200");
  expect(pill()!.textContent).toBe(zh.trader.copy.notEnoughBalance);
  expect(cta().disabled).toBe(true);
  await type("100");
  expect(pill()).toBeNull();
  expect(cta().disabled).toBe(false);
  // No sentence anywhere on the panel for the amount.
  expect(container.textContent).not.toContain(zh.trader.copy.enterAmount);
  expect(container.textContent).not.toContain("開始跟單");
});
