// @vitest-environment happy-dom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CopyPanel, usePanelSetup } from "../src/components/trader/copy-panel";
import { I18nProvider } from "../src/i18n/provider";
import { catalogs } from "../src/i18n/messages";
import { liveSetupMessages } from "../src/i18n/live-setup";
import { liveCopiesMessages } from "../src/i18n/live-copies";

/**
 * The trader panel's 測試網 card (logic review 2026-10-06 §A, §C): a start
 * that failed or whose consent lapsed is not 跟單中 but offers 重新開始 /
 * 取消設定; a running copy shows its localized stage under 狀態; a setup
 * the panel follows is never shown to another signed-in person.
 */
const state = vi.hoisted(() => ({ identity: "owner@email", item: null as unknown, restart: vi.fn(), cancel: vi.fn(), start: vi.fn(), startPending: false,
  deployment: { network: "testnet", available: true, sourceNetworks: ["mainnet", "testnet"], caps: null } as unknown }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/zh-TW/trader", useSearchParams: () => new URLSearchParams() }));
vi.mock("../src/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", identity: state.identity, login() {} }) }));
vi.mock("../src/lib/api", async () => ({ ...(await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api")), sessionKey: () => "1" }));
vi.mock("../src/lib/copy", () => ({
  useCopyOverview: () => ({ data: { paper: { balance: 1000 }, limits: { minAllocationUsd: 100 }, platform: { pauseNewRisk: false, reduceOnly: false }, user: { pauseNewRisk: false, reduceOnly: false } } }),
  useCopyOf: () => undefined, useStartCopy: () => ({ mutate() {}, isPending: false }),
}));
vi.mock("../src/lib/copy-live-setup", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/copy-live-setup")>("../src/lib/copy-live-setup")),
  useLiveCopyAvailable: () => true, useLiveCopyDeployment: () => state.deployment,
  useLiveCopySetup: () => ({ data: undefined, isError: false, walletError: null }),
  useLiveCopySetupActions: () => ({ start: { isPending: state.startPending, mutateAsync: state.start }, confirm: { isPending: false }, restart: { isPending: false, mutateAsync: state.restart }, cancel: { isPending: false, mutateAsync: state.cancel, mutate() {} } }),
}));
vi.mock("../src/lib/copy-live-portfolio", () => ({ useLiveCopyPortfolio: () => ({ data: { items: state.item ? [state.item] : [] } }) }));
vi.mock("../src/lib/wallet", () => ({ useWallet: () => ({ data: { network: (state.deployment as { network: string }).network, hyperliquid: { withdrawable: 500 } } }), signErrorMessage: () => ({ rejected: false, message: "" }) }));
vi.mock("../src/lib/queries", () => ({ useSiteSettings: () => ({ data: { copyTradingEnabled: true } }) }));

const leader = `0x${"ab".repeat(20)}`;
const zh = liveSetupMessages["zh-TW"];
const item = (extra: object) => ({ strategyId: 7, leaderAddress: leader, sourceNetwork: "mainnet", budgetUsd: "150", status: "paused", stage: "setup", createdAt: new Date().toISOString(),
  accountId: "acct", accountAddress: `0x${"22".repeat(20)}`, mandate: null, stop: null, pendingTransfer: null, lastRefusal: null, ...extra });
const setupOf = (stage: string, extra: object = {}) => ({ id: "0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c", kind: "start", stage, issue: null, signer: null, consent: null, ...extra });

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks(); state.identity = "owner@email";
  state.deployment = { network: "testnet", available: true, sourceNetworks: ["mainnet", "testnet"], caps: null };
  localStorage.setItem(`orbie:copy-mode:${state.identity}`, "testnet");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); });
async function render() {
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={catalogs["zh-TW"]}><CopyPanel address={leader} /></I18nProvider>));
}
const button = (label: string) => [...container.querySelectorAll("button")].find(b => b.textContent === label);

it("a start that failed after its deposit is not 跟單中: 重新開始 restarts it, 取消設定 ends it", async () => {
  state.item = item({ setup: setupOf("failed", { issue: "setup_account_mode_failed" }) });
  state.restart.mockResolvedValue({ id: "next", stage: "provisioning" });
  await render();
  expect(container.textContent).not.toContain(zh.copying);
  expect(container.textContent).toContain(zh.failed);
  expect(container.textContent).toContain(zh.errors.setup_account_mode_failed);
  await act(async () => button(zh.restart)!.click());
  expect(state.restart).toHaveBeenCalledExactlyOnceWith("0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c");
  await act(async () => button(zh.cancelSetup)!.click());
  expect(state.cancel).toHaveBeenCalledExactlyOnceWith("0b0a6a3e-2f6b-4b7a-9a65-6b7c9f1e2d3c");
});

it("a start whose consent lapsed (the sheet closed, the page reloaded) offers the same way out", async () => {
  state.item = item({ setup: setupOf("awaiting_consent") });
  await render();
  expect(container.textContent).toContain(zh.consentLapsed);
  expect(button(zh.restart)).toBeTruthy(); expect(button(zh.cancelSetup)).toBeTruthy();
});

it("a running copy shows its stage in the page's language under 狀態, not the raw enum", async () => {
  state.item = item({ status: "active", stage: "active", mandate: { id: "m", state: "active", revision: 2 } });
  await render();
  expect(container.textContent).toContain(zh.copying);
  expect(container.textContent).toContain(`${zh.status}${liveCopiesMessages["zh-TW"].stages.active}`);
  expect(container.textContent).not.toContain("部位");
  expect(container.textContent).not.toMatch(/\bactive\b/);
});

it("a setup the panel follows belongs to the signed-in person: another person in the same tab sees none", async () => {
  const seen: { current: ReturnType<typeof usePanelSetup> | null } = { current: null };
  function Probe({ identity }: { identity: string }) { const value = usePanelSetup(identity, leader); useLayoutEffect(() => { seen.current = value; }); return null; }
  await act(async () => root.render(<Probe identity="a@email" />));
  await act(async () => seen.current![1]({ confirmOpen: true, progressId: "setup-of-a" }));
  expect(seen.current![0]).toMatchObject({ confirmOpen: true, progressId: "setup-of-a" });
  await act(async () => root.render(<Probe identity="b@email" />));
  expect(seen.current![0]).toEqual({ setup: null, confirmOpen: false, progressId: null });
});

it("a slow start shows it is preparing for the whole request, and the confirm sheet opens when it answers, even after a remount", async () => {
  state.item = null;
  let answer!: (setup: unknown) => void;
  state.start.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
  await render();
  const amount = container.querySelector("input#copy-amount") as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(amount, "150"); amount.dispatchEvent(new Event("input", { bubbles: true })); });
  const cta = () => container.querySelector('button[type="submit"]') as HTMLButtonElement;
  await act(async () => cta().click());
  expect(state.start).toHaveBeenCalledTimes(1);
  // Busy: Orbie's orbit mark, and a second press sends nothing.
  expect(cta().getAttribute("aria-busy")).toBe("true");
  expect(cta().textContent).toContain(zh.preparing);
  await act(async () => cta().click());
  expect(state.start).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain(zh.preparingHint);
  // The panel is drawn again while Privy prepares the wallet (11.7 s on Stage): still preparing.
  await act(async () => root.unmount()); root = createRoot(container);
  await render();
  expect(cta().textContent).toContain(zh.preparing);
  const consent = { kind: "start", masterPolicyId: "policy", consentExpiresAt: Date.now() + 300_000, nonce: Date.now(), leaderAddress: leader, budgetUsd: "150", agentValidUntil: Date.now() + 30 * 86_400_000,
    builderAddress: null, builderMaxFeeTenthsOfBps: 0 };
  await act(async () => { answer({ ...setupOf("awaiting_consent", { consent }), strategyId: 7, leaderAddress: leader, budgetUsd: "150", settings: { direction: "same", sizingMode: "ratio", perTradeUsd: null, maxTotalExposureUsd: null, maxLeverage: null, copyStartMode: "delta" } }); });
  expect(document.body.textContent).toContain(zh.confirmTitle);
  expect(cta().textContent).not.toContain(zh.preparing);
});

it("on a mainnet deployment the actual mode is 正式 and 測試網 appears nowhere; a fixed 12–15 USDC a trade is the only sizing", async () => {
  state.deployment = { network: "mainnet", available: true, sourceNetworks: ["mainnet"], caps: { fixedPerTradeUsd: { min: 12, max: 15 }, maxAllocationUsd: 50, maxLeverage: 3, maxStrategiesPerUser: 2 } };
  state.item = null;
  await render();
  expect(container.textContent).not.toContain("測試網");
  expect(container.textContent).toContain("正式");
  expect(container.textContent).toContain("使用 Hyperliquid 主網的真實 USDC。");
  expect(container.querySelector("[data-sizing='fixed-only']")?.textContent).toBe(zh.fixed);
  expect(container.querySelector("input[placeholder='12–15']")).toBeTruthy();
  // A running copy: 跟單中 · 正式.
  state.item = item({ status: "active", stage: "active", mandate: { id: "m", state: "active", revision: 2 } });
  await render();
  expect(container.textContent).toContain("跟單中 · 正式");
  expect(container.textContent).not.toContain("測試網");
});

it("on a testnet deployment the actual mode is still 測試網", async () => {
  state.item = null;
  await render();
  expect(container.textContent).toContain("測試網");
  expect(container.textContent).not.toContain("正式");
});
