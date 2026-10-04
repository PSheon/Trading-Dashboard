// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PortfolioView } from "@/components/portfolio-view";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import { fixtureCopyOverview } from "@/fixtures/copy";
const state = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
// Testnet copies have their own tests (live-copies.test.tsx).
vi.mock("@/components/copy/live-copies", () => ({ LiveCopies: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => window.location.pathname, useSearchParams: () => new URLSearchParams(window.location.search), useRouter: () => ({ replace: state.replace, push: state.push }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signedIn" }) }));
vi.mock("@/lib/copy", () => ({ useCopyOverview: () => ({ data: fixtureCopyOverview() }), useCopyPortfolio: () => ({ data: undefined }) }));
vi.mock("@/components/copy/portfolio-parts", () => ({ PortfolioChart: () => null, PaperSummary: () => null, InsightsPanel: () => null, ExposurePanel: () => null }));
vi.mock("@/lib/wallet", () => ({ useWallet: () => ({ data: { totalValue: 0, network: "testnet" } }) }));
vi.mock("@/components/wallet/wallet-modals", () => ({ useWalletModals: () => ({ openDeposit() {}, openWithdraw() {} }) }));
vi.mock("@/components/copy/copy-activity", () => ({ CopyActivity: () => null }));
// Isolate the selection boundary; the real cards/detail and responsive layouts run in Playwright.
vi.mock("@/components/copy/copy-portfolio", () => ({
  useLeaders: () => new Map(),
  CopyTable: ({ onSelect }: { onSelect(id: number): void }) => <button onClick={() => onSelect(1)}>Select desktop copy</button>,
  CopyCards: ({ onSelect }: { onSelect(id: number): void }) => <button onClick={() => onSelect(1)}>Select mobile copy</button>,
  CopyDetail: ({ onBack }: { onBack(): void }) => <button onClick={onBack}>Back to copies</button>,
}));
let root: Root, container: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); state.replace.mockReset(); state.push.mockReset(); window.history.replaceState(null, "", "/portfolio?paper=empty&filter=alpha&filter=beta#positions"); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function render() { await act(async () => root.render(<I18nProvider locale="en" messages={en}><PortfolioView/></I18nProvider>)); }
async function click(text: string) { await act(async () => { const button = [...container.querySelectorAll("button")].find(item => item.textContent === text); if (!button) throw new Error(`Missing ${text}`); button.click(); }); }
it.each(["Select desktop copy", "Select mobile copy"])("%s changes only local history, preserving repeated queries and hash", async label => {
  const historyLength = window.history.length, replace = vi.spyOn(window.history, "replaceState"), fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  try { await render(); await click(label); expect(window.location.pathname + window.location.search + window.location.hash).toBe("/portfolio?paper=empty&filter=alpha&filter=beta&copy=1#positions"); expect(replace).toHaveBeenCalledExactlyOnceWith(null, "", "/portfolio?paper=empty&filter=alpha&filter=beta&copy=1#positions"); expect(window.history.length).toBe(historyLength); expect(state.replace).not.toHaveBeenCalled(); expect(state.push).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); }
});
it("Back removes only copy and keeps the same path, remaining query values, fragment and history entry", async () => {
  window.history.replaceState(null, "", "/portfolio?copy=1&paper=empty&filter=alpha&filter=beta#positions"); const historyLength = window.history.length, replace = vi.spyOn(window.history, "replaceState"); await render(); await click("Back to copies"); expect(window.location.pathname + window.location.search + window.location.hash).toBe("/portfolio?paper=empty&filter=alpha&filter=beta#positions"); expect(replace).toHaveBeenCalledExactlyOnceWith(null, "", "/portfolio?paper=empty&filter=alpha&filter=beta#positions"); expect(window.history.length).toBe(historyLength); expect(state.replace).not.toHaveBeenCalled();
});
it("selection and Back retain the local query contract over successive renders", async () => { await render(); await click("Select desktop copy"); await render(); expect(window.location.search).toContain("copy=1"); await click("Back to copies"); await render(); expect(window.location.search).not.toContain("copy="); await click("Select mobile copy"); expect(window.location.search).toContain("copy=1"); expect(window.location.hash).toBe("#positions"); expect(state.replace).not.toHaveBeenCalled(); });
it("preserves newer query and fragment edits made after the selection handler rendered", async () => { await render(); window.history.replaceState(null, "", "/portfolio?tag=latest&tag=second#receipt-rows"); await click("Select desktop copy"); expect(window.location.pathname + window.location.search + window.location.hash).toBe("/portfolio?tag=latest&tag=second&copy=1#receipt-rows"); expect(state.replace).not.toHaveBeenCalled(); });
