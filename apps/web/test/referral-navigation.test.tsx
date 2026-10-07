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
  useCurrentLocale: () => "en",
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
vi.mock("@/components/settings/copy-wallets", () => ({
  CopyWalletsList: () => <div>execution-wallets</div>,
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
  expect(html).not.toContain('role="dialog"');
  expect(html).toContain('data-testid="phone-settings"');
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

it("phone settings root is an ordinary page with back navigation, 44px rows and delete last", () => {
  state.view = "root";
  const html = renderToStaticMarkup(<SettingsView />);
  const phone=html.slice(html.indexOf('data-testid="phone-settings"'));
  expect(phone).not.toContain('aria-modal="true"');
  expect(phone).toContain('settings.back');
  expect(phone).toContain('size-11');
  expect(phone).toContain('h-11');
  for(const key of ['settings.menu.account','settings.notifications','settings.language','settings.history','referral.title','theme.label','settings.feedbackTitle','settings.privacy','settings.terms','settings.logout','deleteAccount.title']) expect(phone).toContain(key);
  expect(phone.indexOf('settings.logout')).toBeLessThan(phone.indexOf('deleteAccount.title'));
});

vi.mock("@/components/shell/account-controls", () => ({ AuthButton: () => null }));
