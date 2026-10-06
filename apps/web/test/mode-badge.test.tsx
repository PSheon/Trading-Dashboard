// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/app-shell";
import { CopyPanel } from "@/components/trader/copy-panel";
import { I18nProvider } from "@/i18n/provider";
import { zhTW } from "@/i18n/messages/zh-TW";

const state = vi.hoisted(() => ({ automatic: false, pathname: "/explore", get: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signedIn", mode: "privy", identity: "owner@email", wallet: { address: `0x${"11".repeat(20)}` }, login() {} }) }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname, useRouter: () => ({ refresh() {}, push() {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/api", async () => ({ ...(await vi.importActual<typeof import("@/lib/api")>("@/lib/api")), api: { get: state.get, post: vi.fn() }, sessionKey: () => "1" }));
vi.mock("@/components/shell/account-controls", () => ({ AccountControls: () => null, AuthButton: () => null }));
vi.mock("@/components/shell/address-search", () => ({ AddressSearch: () => null }));
vi.mock("@/components/shell/announcement-banner", () => ({ AnnouncementBanner: () => null }));
vi.mock("@/components/shell/maintenance-banner", () => ({ MaintenanceBanner: () => null }));
vi.mock("@/components/copy/copy-feed", () => ({ CopyFeed: () => null }));
vi.mock("@/lib/queries", () => ({ useSiteSettings: () => ({ data: { copyTradingEnabled: true } }) }));
vi.mock("@/components/wallet/wallet-modals", () => ({ WalletModalsProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/copy", () => ({
  useCopyOverview: () => ({ data: { paper: { balance: 1000 }, limits: { minAllocationUsd: 100 }, platform: { pauseNewRisk: false, reduceOnly: false }, user: { pauseNewRisk: false, reduceOnly: false } } }),
  useCopyOf: () => undefined, useStartCopy: () => ({ mutate() {}, mutateAsync: async () => ({}), isPending: false }),
}));
vi.mock("@/lib/wallet", () => ({ useWallet: () => ({ data: undefined }), signErrorMessage: () => ({ rejected: false, message: "" }) }));

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.get.mockImplementation(async () => ({ mode: "actual", network: "testnet", capabilities: { strategyPreparation: true, automaticExecution: state.automatic, sourceNetworks: ["mainnet"] }, strategies: [], mandates: [] }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });

async function shell(pathname: string) {
  state.pathname = pathname;
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="zh-TW" messages={zhTW}><AppShell><p>page</p></AppShell></I18nProvider></QueryClientProvider>));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const badges = (scope: ParentNode) => [...scope.querySelectorAll("[data-mode]")].map((el) => el.textContent);

it("says 模擬 once, beside the wordmark, where this deployment runs no testnet copies (the public build)", async () => {
  state.automatic = false;
  await shell("/explore");
  expect(badges(container.querySelector("header.orbit-header")!)).toEqual(["模擬"]);
  expect(badges(container)).toEqual(["模擬"]);
});

it("says 測試網 only where testnet copies run (the api's automaticExecution), never from a hostname", async () => {
  state.automatic = true;
  await shell("/explore");
  expect(badges(container)).toEqual(["測試網"]);
});

it("has one badge per bar on the phone home (the desktop header is hidden there)", async () => {
  state.automatic = false;
  await shell("/");
  const phone = [...container.querySelectorAll("header")].find((h) => !h.className.includes("orbit-header"))!;
  expect(badges(phone)).toEqual(["模擬"]);
});

it("the copy panel carries no mode chip of its own (the header says it)", () => {
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><I18nProvider locale="zh-TW" messages={zhTW}><CopyPanel address={`0x${"ab".repeat(20)}`} /></I18nProvider></QueryClientProvider>);
  expect(html).toContain("順向");
  expect(html).not.toMatch(/>模擬</);
});
