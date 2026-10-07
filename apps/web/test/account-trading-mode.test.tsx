// @vitest-environment happy-dom
import { act, Children, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountControls } from "@/components/shell/account-controls";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
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
vi.mock("@/components/ui/dropdown-menu", () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { DropdownMenu: Wrap, DropdownMenuContent: Wrap, DropdownMenuItem: Wrap, DropdownMenuLabel: Wrap, DropdownMenuSeparator: () => null, DropdownMenuTrigger: Wrap,
    DropdownMenuRadioGroup: ({ children, value, onValueChange }: { children: ReactNode; value: string; onValueChange: (value: string) => void }) => <div>{Children.map(children, child => {
      const item = child as ReactElement<{ value: string }>;
      return cloneElement(item, { onClick: () => onValueChange(item.props.value), "aria-checked": value === item.props.value } as object);
    })}</div>,
    DropdownMenuRadioItem: ({ children, value, ...props }: { children: ReactNode; value: string }) => <button role="menuitemradio" aria-checked="false" data-value={value} {...props}>{children}</button>,
  };
});
let root: Root, host: HTMLDivElement, client: QueryClient;
beforeEach(async () => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear(); host = document.createElement("div"); root = createRoot(host); client = new QueryClient(); await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={en}><AccountControls /></I18nProvider></QueryClientProvider>)); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); localStorage.clear(); });
const mode = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')].find(item => item.textContent?.startsWith(name))!;
it("shows paper equity without actual equity or a real deposit, and switches every account control to live together", async () => {
  expect(host.querySelector('[data-testid="account-total"]')?.textContent).toBe("$1,234.00");
  expect(host.textContent).not.toContain("Deposit");
  expect(mode("Testnet").disabled).toBe(true);
  await act(async () => mode("Live").click());
  expect(host.querySelector('[data-testid="account-total"]')?.textContent).toBe("$50.00");
  expect(host.textContent).toContain("Deposit");
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
