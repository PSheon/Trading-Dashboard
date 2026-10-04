// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { SettingsView } from "@/components/settings/settings-view";
const state = vi.hoisted(() => ({
  mode: "privy",
  status: "signedIn",
  tab: "referral",
  view: "referral",
  desktop: true,
  render: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useSearchParams: () =>
    new URLSearchParams({ tab: state.tab, view: state.view }),
  useRouter: () => ({ push() {}, replace() {}, back() {} }),
}));
vi.mock("@/lib/auth", () => ({
  useMe: () => ({ data: { email: "alice@example.test", displayName: null } }),
  useAuth: () => ({
    ...state,
    identity: "alice",
    wallet: null,
    login() {},
    logout() {},
  }),
}));
vi.mock("@/lib/me", () => ({
  useMe: () => ({ data: { email: "alice@example.test", displayName: null } }),
}));
vi.mock("@/lib/wallet", () => ({
  useWallet: () => ({ data: undefined, isPending: false }),
  useWalletAddress: () => null,
}));
vi.mock("@/lib/use-change-locale", () => ({ useChangeLocale: () => () => {} }));
vi.mock("@/lib/use-is-desktop", () => ({
  useIsDesktop: () => state.desktop,
}));
vi.mock("@/lib/use-modal-focus", () => ({
  useModalFocus: () => ({ current: null }),
}));
vi.mock("@/i18n/provider", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: "en", format: {} }),
}));
vi.mock("@/components/wallet/wallet-modals", () => ({
  useWalletModals: () => ({
    openDeposit() {},
    openWithdraw() {},
    openExport() {},
  }),
}));
vi.mock("@/components/wallet/history-list", () => ({
  WalletHistoryList: () => null,
}));
vi.mock("@/components/settings/bot-rows", () => ({
  AlertBotRow: () => null,
  TradingBotRow: () => null,
}));
vi.mock("@/components/settings/delete-account", () => ({
  DeleteAccountDialog: () => null,
  DeleteAccountButton: () => null,
}));
vi.mock("@/components/settings/execution-wallets", () => ({
  ExecutionWalletSettings: () => <div>execution-wallets</div>,
}));
vi.mock("@/components/settings/referral", () => ({
  ReferralSettings: () => {
    state.render();
    return <div>private-referrals</div>;
  },
}));
beforeEach(() => {
  state.mode = "privy";
  state.status = "signedIn";
  state.tab = "referral";
  state.view = "referral";
  state.render.mockClear();
});
it("mounts the explicit referral deep-link in both desktop and phone settings with accessible navigation", () => {
  const html = renderToStaticMarkup(<SettingsView />);
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('role="dialog"');
  expect(html).toContain("private-referrals");
  expect(state.render).toHaveBeenCalledTimes(2);
});
it.each(["fixture", "none"])(
  "unsupported %s provider hides referral navigation and ignores private referral deep-links",
  (mode) => {
    state.mode = mode;
    const html = renderToStaticMarkup(<SettingsView />);
    expect(html).not.toContain("private-referrals");
    expect(html).not.toContain("referral.title");
    expect(state.render).not.toHaveBeenCalled();
  },
);
