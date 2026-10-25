// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CopyWalletsList } from "@/components/settings/copy-wallets";
import { TradingBotRow } from "@/components/settings/bot-rows";
import { SettingsView } from "@/components/settings/settings-view";
import { liveSetupText } from "@/i18n/live-setup";
import { zhTW } from "@/i18n/messages/zh-TW";
import { I18nProvider } from "@/i18n/provider";

/** Settings stays minimal (Paul, 2026-10-25): the copy wallets are one row
 * with their count that opens the list, the owner sentence and the copy
 * notification sentence are hover text, and the page has one 設定 heading. */
const state = vi.hoisted(() => ({
  desktop: true as boolean | undefined,
  exported: [] as Array<{ address: string; strategyId: number }>,
  revoked: [] as string[],
  revokePending: false,
}));
const live = liveSetupText("zh-TW", "mainnet");
const address = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
const accounts = Array.from({ length: 14 }, (_, i) => ({ id: `acct-${i + 1}`, strategyId: i + 1, network: "mainnet", state: "ready", address: address(i + 1), automaticReturn: i === 0 }));

vi.mock("next/navigation", () => ({ usePathname: () => "/settings", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {}, replace() {}, back() {} }) }));
vi.mock("@/i18n/navigation", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>, usePathname: () => "/settings", useRouter: () => ({ push() {}, replace() {}, back() {} }) }));
vi.mock("@/lib/use-is-desktop", () => ({ useIsDesktop: () => state.desktop }));
vi.mock("@/lib/auth", () => ({ useMe: () => ({ data: { email: "alice@example.test", displayName: null } }), useAuth: () => ({ status: "signedIn", mode: "fixture", identity: "alice", wallet: null, login() {}, logout() {} }) }));
vi.mock("@/lib/wallet", () => ({ useWallet: () => ({ data: undefined, isPending: false }), useWalletAddress: () => null }));
vi.mock("@/lib/use-change-locale", () => ({ useChangeLocale: () => () => {} }));
vi.mock("@/lib/use-logout", () => ({ useLogout: () => ({ pending: false, logout() {} }) }));
vi.mock("@/lib/site-mode", () => ({ useTradingMode: () => ({ mode: "paper", available: false }) }));
vi.mock("@/lib/copy", () => ({ useCopyOverview: () => ({ data: undefined }) }));
vi.mock("@/components/wallet/funds-history", () => ({ FundsHistory: () => null }));
vi.mock("@/components/settings/delete-account", () => ({ DeleteAccountDialog: () => null, DeleteAccountButton: () => null }));
vi.mock("@/components/settings/referral", () => ({ ReferralSettings: () => null }));
vi.mock("@/components/shell/theme-toggle", () => ({ ThemeChoiceControl: () => null }));
vi.mock("@/components/wallet/wallet-modals", () => ({ useWalletModals: () => ({ openDeposit() {}, openWithdraw() {}, openExport: (target: { address: string; strategyId: number }) => state.exported.push(target) }) }));
vi.mock("@/components/copy/live-copy-setup-dialogs", () => ({ useLiveSetupText: () => live }));
vi.mock("@/lib/copy-execution-wallets", () => ({
  useExecutionWallets: () => ({ data: { available: true, network: "mainnet", accounts, authorizations: [{ id: "grant-1", accountAddress: address(1), status: "active", expiresAt: "2026-11-20T00:00:00Z" }] } }),
  useRevokeWalletAuthorization: () => ({ isPending: state.revokePending, isError: false, variables: undefined, reset() {}, mutate: (id: string, options?: { onSuccess?: () => void }) => { state.revoked.push(id); options?.onSuccess?.(); } }),
}));
vi.mock("@/lib/alerts", () => ({
  TELEGRAM_KEY: ["telegram"],
  useTelegramStatus: () => ({ data: { linked: true, enabled: true, bot: "orbie_fun_bot", username: "alice", copyAlertsEnabled: true }, isError: false, isFetching: false, refetch() {} }),
  useSetCopyAlerts: () => ({ isPending: false, isError: false, mutate() {} }),
  useCreateTelegramLink: () => ({ isPending: false, mutate() {} }),
  useTelegramTest: () => ({ isPending: false, mutate() {} }),
  useUnlinkTelegram: () => ({ isPending: false, mutate() {} }),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries() {} }) }));

let root: Root;
let host: HTMLDivElement;
const view = (node: React.ReactNode) => <I18nProvider locale="zh-TW" messages={zhTW}>{node}</I18nProvider>;
async function render(node: React.ReactNode) { await act(async () => root.render(view(node))); }
const visibleText = (el: Element) => [...el.querySelectorAll("p,span,h3,li,button")].filter((n) => !n.closest(".sr-only") && !n.classList.contains("sr-only")).map((n) => n.childNodes).flatMap((nodes) => [...nodes].filter((c) => c.nodeType === 3).map((c) => c.textContent)).join("");

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.desktop = true; state.exported = []; state.revoked = [];
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("settings", () => {
  it("collapses the copy wallets to one row with their count; the owner sentence is the row's hover", async () => {
    await render(<CopyWalletsList />);
    const row = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.textContent).toBe(`${live.wallets}14`);
    expect(host.querySelector('[data-testid="copy-wallets-count"]')!.textContent).toBe("14");
    expect(row.getAttribute("title")).toBe(live.walletsHint);
    expect(host.textContent).not.toContain(live.walletsHint);
    expect(host.textContent).not.toContain(live.exportKey);
    expect(host.querySelectorAll("button")).toHaveLength(1);

    await act(async () => row.click());
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(row.getAttribute("aria-controls")!)).not.toBeNull();
    const buttons = () => [...host.querySelectorAll("button")];
    // Ten a page, each with 匯出私鑰; the pager reaches the other four.
    expect(buttons().filter((b) => b.textContent === live.exportKey)).toHaveLength(10);
    await act(async () => buttons().find((b) => b.textContent === live.exportKey)!.click());
    expect(state.exported).toEqual([{ address: address(1), strategyId: 1 }]);
    // 撤銷 still asks first.
    await act(async () => buttons().find((b) => b.textContent!.startsWith(live.revoke))!.click());
    expect(state.revoked).toEqual([]);
    await act(async () => buttons().find((b) => b.textContent === zhTW.executionWallets.confirmRevoke)!.click());
    expect(state.revoked).toEqual(["grant-1"]);
    await act(async () => buttons().find((b) => b.textContent === zhTW.common.next)!.click());
    expect(buttons().filter((b) => b.textContent === live.exportKey)).toHaveLength(4);
  });

  it("the copy-notification row says what it does behind an ⓘ, not in a sentence", async () => {
    await render(<TradingBotRow />);
    expect(visibleText(host)).not.toContain(zhTW.copyUpdates.alertHint);
    const tip = host.querySelector<HTMLButtonElement>(`button[aria-label="${zhTW.common.moreInfo}"]`)!;
    expect(document.getElementById(tip.getAttribute("aria-describedby")!)!.textContent).toBe(zhTW.copyUpdates.alertHint);
  });

  for (const desktop of [true, false]) {
    it(`has one 設定 heading once the width is known (desktop: ${desktop})`, async () => {
      state.desktop = desktop;
      await render(<SettingsView />);
      expect([...host.querySelectorAll("h1")].map((h) => h.textContent)).toEqual([zhTW.settings.title]);
      expect(host.querySelectorAll('[data-testid="phone-settings"]')).toHaveLength(desktop ? 0 : 1);
    });
  }

  it("serves both layouts before hydration (CSS picks one)", () => {
    state.desktop = undefined;
    const html = renderToStaticMarkup(view(<SettingsView />));
    expect(html).toContain('data-testid="phone-settings"');
    expect(html).toContain("hidden md:block");
  });
});
