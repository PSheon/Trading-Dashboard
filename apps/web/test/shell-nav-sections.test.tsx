// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/app-shell";
import { isActive } from "@/components/shell/nav";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";

const state = vi.hoisted(() => ({ pathname: "/explore" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: "signedIn" }) }));
vi.mock("next/navigation", async () => { const { routeGroupOf } = await import("./route-group-of"); return { usePathname: () => state.pathname, useSelectedLayoutSegment: () => routeGroupOf(state.pathname), useRouter: () => ({ refresh() {} }) }; });
vi.mock("@/components/shell/account-controls", () => ({ AccountControls: () => null, AuthButton: () => null }));
vi.mock("@/components/shell/address-search", () => ({ AddressSearch: () => null }));
vi.mock("@/components/shell/phone-menu", () => ({ PhoneMenu: () => null }));
vi.mock("@/components/shell/announcement-banner", () => ({ AnnouncementBanner: () => null }));
vi.mock("@/components/shell/maintenance-banner", () => ({ MaintenanceBanner: () => null }));
vi.mock("@/components/copy/copy-feed", () => ({ CopyFeed: () => null }));
vi.mock("@/lib/queries", () => ({ useSiteSettings: () => ({ data: undefined }) }));
vi.mock("@/components/wallet/wallet-modals", () => ({ WalletModalsProvider: ({ children }: { children: React.ReactNode }) => children }));

const TRADER = `/trader/0x${"ab".repeat(20)}`;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** The header's two capsules, as rendered on a path: each link's name,
 * whether it is lit, and its classes (the inactive look is one style). */
async function capsules(pathname: string) {
  state.pathname = pathname;
  await act(async () => root.render(<I18nProvider locale="en" messages={en}><AppShell><p>page</p></AppShell></I18nProvider>));
  const header = container.querySelector("header.orbit-header")!;
  return [...header.querySelectorAll("nav a")].map((a) => ({
    name: a.getAttribute("aria-label"),
    lit: a.getAttribute("aria-current") === "page",
    disabled: a.hasAttribute("aria-disabled") || a.hasAttribute("disabled"),
    className: a.className,
  }));
}

/** 2026-10-23: on a trader page nothing was lit, so 探索 / 洞察 / 投資組合 /
 * 收藏 all sat in the inactive grey and the signed-in header looked
 * disabled next to the explore page's. A trader page is reached from 探索
 * and lights it; the other links keep the one inactive style everywhere. */
it("lights 探索 on a trader page as on the explore page, with the same links and styles under both route groups", async () => {
  const explore = await capsules("/explore");
  const trader = await capsules(TRADER);
  expect(explore.map((l) => l.name)).toEqual(["Explore", "Insights", "Portfolio", "Saved"]);
  expect(trader.map((l) => l.name)).toEqual(explore.map((l) => l.name));
  expect(explore.map((l) => l.lit)).toEqual([true, false, false, false]);
  expect(trader.map((l) => l.lit)).toEqual([true, false, false, false]);
  expect(trader.map((l) => l.className)).toEqual(explore.map((l) => l.className));
  expect(trader.some((l) => l.disabled)).toBe(false);
  // 投資組合 / 收藏 are never greyed any further than the inactive style.
  for (const link of [...explore, ...trader].filter((l) => l.name === "Portfolio" || l.name === "Saved")) {
    expect(link.className).not.toMatch(/opacity|disabled|pointer-events-none/);
  }
});

it("keeps the sections apart: a trader page is under 探索 only", () => {
  expect(isActive(TRADER, "/explore")).toBe(true);
  expect(isActive(TRADER, "/insights")).toBe(false);
  expect(isActive(TRADER, "/portfolio")).toBe(false);
  expect(isActive(TRADER, "/favorites")).toBe(false);
  expect(isActive(TRADER, "/")).toBe(false);
  expect(isActive("/explore", "/explore")).toBe(true);
  expect(isActive("/favorites", "/explore")).toBe(false);
});
