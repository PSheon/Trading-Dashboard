// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/app-shell";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";

const state = vi.hoisted(() => ({ status: "signedOut", pathname: "/explore" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: state.status }) }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname, useRouter: () => ({ refresh() {} }) }));
vi.mock("@/components/shell/account-controls", () => ({ AccountControls: () => null, AuthButton: () => null }));
vi.mock("@/components/shell/address-search", () => ({ AddressSearch: () => null }));
vi.mock("@/components/shell/phone-menu", () => ({ PhoneMenu: () => null }));
vi.mock("@/components/shell/announcement-banner", () => ({ AnnouncementBanner: () => null }));
vi.mock("@/components/shell/maintenance-banner", () => ({ MaintenanceBanner: () => null }));
vi.mock("@/components/copy/copy-feed", () => ({ CopyFeed: () => null }));
vi.mock("@/components/wallet/wallet-modals", () => ({ WalletModalsProvider: ({ children }: { children: React.ReactNode }) => children }));

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

async function render(status: string) {
  state.status = status;
  await act(async () => root.render(<I18nProvider locale="en" messages={en}><AppShell><p>page</p></AppShell></I18nProvider>));
}
const header = () => container.querySelector("header.orbit-header")!;
const linkNames = (scope: Element) => [...scope.querySelectorAll("a")].map((a) => a.getAttribute("aria-label") ?? a.textContent);
const tabBar = () => [...container.querySelectorAll("nav")].find((nav) => nav.className.includes("bottom-"))!;

/** Paul, 2026-10-05: 投資組合 / 收藏 only once someone is signed in. */
it.each(["signedOut", "loading", "disabled"])("draws no Portfolio / Saved in the header or the tab bar while %s", async (status) => {
  await render(status);
  expect(linkNames(header())).not.toContain("Portfolio");
  expect(linkNames(header())).not.toContain("Saved");
  expect(linkNames(header())).toContain("Explore");
  expect(linkNames(tabBar())).toEqual(["Home", "Explore", "Insights"]);
});

it("shows Portfolio / Saved once signed in", async () => {
  await render("signedIn");
  expect(header().querySelector('nav[aria-label="Mine"]')).not.toBeNull();
  expect(linkNames(header())).toEqual(expect.arrayContaining(["Portfolio", "Saved"]));
  expect(linkNames(tabBar())).toEqual(["Home", "Explore", "Saved", "Portfolio"]);
});

it("keeps the header and the page in one frame", async () => {
  await render("signedOut");
  expect(header().querySelector(".page-frame")).not.toBeNull();
  expect(container.querySelector("main")!.className).toContain("page-frame");
});
