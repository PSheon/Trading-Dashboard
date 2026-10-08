// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountControls } from "@/components/shell/account-controls";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
const display = vi.hoisted(() => ({ desktop: true }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", identity: "alice" }), useMe: () => ({ data: { email: "alice@example.com" } }), useIsAdmin: () => false }));
vi.mock("@/lib/copy-live-setup", () => ({ useLiveCopyDeployment: () => ({ available: true, network: "mainnet" }) }));
vi.mock("@/lib/use-logout", () => ({ useLogout: () => ({ logout() {}, pending: false }) }));
vi.mock("@/lib/use-theme", () => ({ useTheme: () => ({ theme: "light", toggle() {} }) }));
vi.mock("@/lib/wallet", () => ({ useWallet: () => ({ data: { totalValue: 42, network: "mainnet" }, isError: false }) }));
vi.mock("@/lib/copy", () => ({ useCopyOverview: () => ({ data: { paper: { totalValue: 1234 } } }) }));
vi.mock("@/lib/copy-equity", () => ({ useCopiesEquity: () => 8, CopyEquityProbes: () => null }));
vi.mock("@/components/wallet/wallet-modals", () => ({ useWalletModals: () => ({ openDeposit() {} }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));
vi.mock("@/components/shell/language-menu", () => ({ LanguageMenu: () => null }));
vi.mock("@/lib/use-is-desktop", () => ({ useIsDesktop: () => display.desktop }));
let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(async () => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); client = new QueryClient(); await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={en}><AccountControls /></I18nProvider></QueryClientProvider>)); await act(async () => host.querySelector("[data-mode]")!.closest("button")!.click()); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); display.desktop = true; host.remove(); localStorage.clear(); });
const mode = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find(item => item.textContent?.startsWith(name))!;
it("shows paper equity without actual equity or a real deposit, and switches every account control to live together", async () => {
  expect(document.querySelector('[data-testid="account-total"]')?.textContent).toBe("$1,234.00");
  expect(document.body.textContent).not.toContain("Deposit");
  expect(mode("Testnet")).toBeUndefined();
  await act(async () => mode("Live").click());
  expect(document.querySelector('[data-testid="account-total"]')?.textContent).toBe("$50.00");
  expect(document.body.textContent).toContain("Deposit");
  expect(mode("Live").getAttribute("aria-checked")).toBe("true");
});
it("rejects switching while a financial mutation is in progress", async () => {
  let finish!: () => void;
  const mutation = client.getMutationCache().build(client, { mutationFn: () => new Promise<void>(resolve => { finish = resolve; }) });
  let operation!: Promise<void>;
  await act(async () => { operation = mutation.execute(undefined); await new Promise(resolve => setTimeout(resolve, 10)); });
  await act(async () => mode("Live").click());
  expect(host.querySelector('[data-mode]')?.getAttribute("data-mode")).toBe("paper");
  await act(async () => { finish(); await operation; });
});

it("uses a dismissible phone dialog and restores focus to its trigger", async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
  display.desktop = false;
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={en}><AccountControls /></I18nProvider></QueryClientProvider>));
  const trigger = host.querySelector("[data-mode]")!.closest("button")!;
  await act(async () => trigger.click());
  const sheet = document.querySelector('[role="dialog"]')!;
  expect(sheet.querySelector('[role="radiogroup"]')).not.toBeNull();
  const close = [...sheet.querySelectorAll("button")].find(button => button.textContent === "Close")!;
  await act(async () => { close.click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it("offers only the deployment account and simulation with keyboard radio navigation", async () => {
  const choices = document.querySelectorAll('[role="radio"]');
  expect(choices).toHaveLength(2);
  await act(async () => {
    mode("Paper").focus();
    mode("Paper").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  expect(mode("Live").getAttribute("aria-checked")).toBe("true");
});

it("returns desktop focus after Escape closes the account card", async () => {
  const trigger = host.querySelector("[data-mode]")!.closest("button")!;
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(document.querySelector('[data-testid="account-menu-card"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
