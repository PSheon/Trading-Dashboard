// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/app-shell";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";

const state = vi.hoisted(() => ({ pathname: "/explore", auth: { status: "signedIn", restoring: false } as { status: string; restoring?: boolean } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => state.auth }));
vi.mock("next/navigation", async () => { const { routeGroupOf } = await import("./route-group-of"); return { usePathname: () => state.pathname, useSelectedLayoutSegment: () => routeGroupOf(state.pathname), useRouter: () => ({ refresh() {} }) }; });
vi.mock("@/components/shell/account-controls", () => ({ AccountControls: () => null, AuthButton: () => null }));
vi.mock("@/components/shell/address-search", () => ({ AddressSearch: () => null }));
vi.mock("@/components/shell/phone-menu", () => ({ PhoneMenu: () => null }));
vi.mock("@/components/shell/announcement-banner", () => ({ AnnouncementBanner: () => null }));
vi.mock("@/components/shell/maintenance-banner", () => ({ MaintenanceBanner: () => null }));
vi.mock("@/components/copy/copy-feed", () => ({ CopyFeed: () => null }));
vi.mock("@/lib/queries", () => ({ useSiteSettings: () => ({ data: undefined }) }));
vi.mock("@/components/wallet/wallet-modals", () => ({ WalletModalsProvider: ({ children }: { children: React.ReactNode }) => children }));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.auth = { status: "signedIn", restoring: false };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.history.replaceState(null, "", "/");
});

/** The header's 投資組合 / 收藏 capsule on a URL (path and query). */
async function mine(url: string) {
  const [pathname] = url.split("?");
  state.pathname = pathname!;
  window.history.replaceState(null, "", url);
  await act(async () => root.render(<I18nProvider locale="en" messages={en}><AppShell><p>page</p></AppShell></I18nProvider>));
  const nav = container.querySelector('header.orbit-header nav[aria-label="Mine"]');
  return nav ? [...nav.querySelectorAll("a")].map((a) => ({ name: a.getAttribute("aria-label"), lit: a.getAttribute("aria-current") === "page", className: a.className, navClass: nav.className })) : null;
}

const APP_PAGES = ["/", "/explore", "/explore?market=stocks", "/explore?market=stocks&board=xyz:NVDA", "/insights", `/trader/0x${"ab".repeat(20)}`, `/trader/0x${"ab".repeat(20)}?tab=insights`, "/coins/BTC", "/coins/xyz:SP500", "/settings", "/portfolio", "/favorites"];

/** QA on Stage, 2026-10-25: on the trader, insights and coin pages the pair
 * sat in the inactive grey (text-muted-foreground) with nothing lit, which
 * reads as disabled; only /portfolio, where 投資組合 is the orange pill,
 * looked normal. An unlit link is now drawn in the full ink everywhere. */
it("draws 投資組合 / 收藏 on every app page, unlit links in one enabled style", async () => {
  const unlit = new Set<string>();
  for (const url of APP_PAGES) {
    const links = await mine(url);
    expect(links, url).not.toBeNull();
    expect(links!.map((l) => l.name), url).toEqual(["Portfolio", "Saved"]);
    expect(links!.filter((l) => l.lit).map((l) => l.name), url).toEqual(url === "/portfolio" ? ["Portfolio"] : url === "/favorites" ? ["Saved"] : []);
    // No entry animation on the capsule: a resize or a full-page capture
    // restarts it, and the pair was caught half faded or at opacity 0.
    expect(links![0]!.navClass, url).not.toMatch(/animate-in|fade-in|opacity/);
    for (const link of links!.filter((l) => !l.lit)) {
      expect(link.className, url).not.toMatch(/text-muted-foreground|opacity|disabled|pointer-events-none/);
      expect(link.className, url).toMatch(/\btext-foreground\b/);
      unlit.add(link.className);
    }
  }
  expect(unlit.size).toBe(1);
});

/** A full page load of a signed-in visitor (a reload of
 * /explore?market=stocks) waits seconds for Privy to restore the session:
 * the pair was missing all that time. It is drawn while a saved session is
 * being restored; while sign-in is unknown without one it stays hidden. */
it("draws the pair while a saved session is restored, never while signed out", async () => {
  state.auth = { status: "loading", restoring: true };
  expect((await mine("/explore?market=stocks"))?.map((l) => l.name)).toEqual(["Portfolio", "Saved"]);
  state.auth = { status: "loading", restoring: false };
  expect(await mine("/explore?market=stocks")).toBeNull();
  state.auth = { status: "signedOut" };
  expect(await mine("/explore?market=stocks")).toBeNull();
});
