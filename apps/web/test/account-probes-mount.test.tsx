// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthButton } from "@/components/shell/account-controls";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";

/** The deployment read has not answered yet (null), as in the first moment after sign-in. */
const deployment = vi.hoisted(() => ({ value: null as null | { available: boolean; network: string } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", identity: "alice", mode: "privy", login() {} }), useMe: () => ({ data: { email: "alice@example.com" } }), useIsAdmin: () => false }));
vi.mock("@/lib/copy-live-setup", () => ({ useLiveCopyDeployment: () => deployment.value }));
vi.mock("@/lib/use-logout", () => ({ useLogout: () => ({ logout() {}, pending: false }) }));
vi.mock("@/lib/use-theme", () => ({ useTheme: () => ({ choice: "system", theme: "light", setChoice() {}, toggle() {} }) }));
vi.mock("@/lib/use-change-locale", () => ({ useChangeLocale: () => () => {} }));
vi.mock("@/lib/wallet", () => ({ useWallet: () => ({ data: undefined, isError: false }) }));
vi.mock("@/lib/copy", () => ({ useCopyOverview: () => ({ data: undefined }) }));
vi.mock("@/lib/copy-equity", () => ({ useCopiesEquity: () => null, CopyEquityProbes: () => <span data-testid="equity-probes" /> }));
vi.mock("@/components/wallet/wallet-modals", () => ({ useWalletModals: () => ({ openDeposit() {} }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));
vi.mock("@/components/shell/language-menu", () => ({ LanguageMenu: () => null }));
vi.mock("@/lib/use-is-desktop", () => ({ useIsDesktop: () => false }));

let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); client = new QueryClient(); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); localStorage.clear(); deployment.value = null; });

async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={en}><AuthButton compact /></I18nProvider></QueryClientProvider>));
}

/** 2026-10-23, phone header on `/`: the account pill's total sat as a
 * skeleton for seconds after sign-in. In an actual mode the total waits for
 * every copy's equity, read by the probes — which mounted only once the
 * deployment read had answered, putting the execution wallets and each
 * copy's snapshot one round trip later. The probes mount with the pill. */
it("mounts the copies' equity probes before the deployment read has answered", async () => {
  localStorage.setItem("orbie:trading-mode:alice", "live");
  await render();
  expect(host.querySelector('[data-testid="account-total"]')).toBeNull();
  expect(host.querySelector('[data-testid="equity-probes"]')).not.toBeNull();
});

it("keeps the probes off in paper mode (no actual copies to read)", async () => {
  await render();
  expect(host.querySelector('[data-mode="paper"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="equity-probes"]')).toBeNull();
});
