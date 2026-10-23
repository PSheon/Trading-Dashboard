// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountControls } from "@/components/shell/account-controls";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";

const auth = vi.hoisted(() => ({ status: "signedIn" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: auth.status, identity: "alice", mode: "privy", login() {} }), useMe: () => ({ data: { email: "alice@example.com" } }), useIsAdmin: () => false }));
vi.mock("@/lib/copy-live-setup", () => ({ useLiveCopyDeployment: () => ({ available: true, network: "mainnet" }) }));
vi.mock("@/lib/use-logout", () => ({ useLogout: () => ({ logout() {}, pending: false }) }));
vi.mock("@/lib/use-theme", () => ({ useTheme: () => ({ choice: "system", theme: "light", setChoice() {}, toggle() {} }) }));
vi.mock("@/lib/use-change-locale", () => ({ useChangeLocale: () => () => {} }));
vi.mock("@/lib/wallet", () => ({ useWallet: () => ({ data: undefined, isError: false }) }));
vi.mock("@/lib/copy", () => ({ useCopyOverview: () => ({ data: { paper: { totalValue: 1234 } } }) }));
vi.mock("@/lib/copy-equity", () => ({ useCopiesEquity: () => 0, CopyEquityProbes: () => null }));
vi.mock("@/components/wallet/wallet-modals", () => ({ useWalletModals: () => ({ openDeposit() {} }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));
vi.mock("@/components/shell/language-menu", () => ({ LanguageMenu: () => null }));
vi.mock("@/lib/use-is-desktop", () => ({ useIsDesktop: () => true }));

let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); client = new QueryClient(); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); });

async function render(status: string) {
  auth.status = status;
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={en}><AccountControls /></I18nProvider></QueryClientProvider>));
  return host.querySelector<HTMLButtonElement>('button[data-testid="theme-toggle"]');
}

/** 2026-10-23: at 1440px a signed-in header had no theme button — it was
 * drawn only in the signed-out branch, so signed in it lived nowhere but the
 * account menu's sub-panel. It is one icon button in the right cluster in
 * both states (desktop only; the phone menu has the three-way choice). */
it.each(["signedIn", "signedOut"])("keeps the theme button in the header's right cluster while %s", async (status) => {
  const toggle = await render(status);
  expect(toggle).not.toBeNull();
  expect(toggle!.getAttribute("aria-label")).toBe("Switch to Dark");
  expect(toggle!.className).toContain("hidden lg:flex");
  // Signed in, it is beside the account pill, not inside its menu.
  expect(toggle!.closest("[data-testid='account-menu-card']")).toBeNull();
  expect(host.querySelectorAll('[data-testid="theme-toggle"]')).toHaveLength(1);
});
