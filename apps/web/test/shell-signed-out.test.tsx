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
vi.mock("@/lib/queries", () => ({ useSiteSettings: () => ({ data: undefined }) }));
vi.mock("@/components/wallet/wallet-modals", () => ({ WalletModalsProvider: ({ children }: { children: React.ReactNode }) => children }));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  history.replaceState(null, "", "/");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); state.pathname="/explore";
});

async function render(status: string) {
  state.status = status;
  await act(async () => root.render(<I18nProvider locale="en" messages={en}><AppShell><p>page</p></AppShell></I18nProvider>));
}
const header = () => container.querySelector("header.orbit-header")!;
const linkNames = (scope: Element) => [...scope.querySelectorAll("a")].map((a) => a.getAttribute("aria-label") ?? a.textContent);
const tabBar = () => container.querySelector("nav.phone-floating-bar")!;

for (const path of ["/explore", "/favorites", "/portfolio", "/insights"]) {
  it.each(["signedOut", "signedIn"])(`keeps the phone top bar and content clearance on ${path} while %s`, async (status) => {
    state.pathname = path;
    await render(status);
    const phone = container.querySelector('[data-testid="app-phone-header"]');
    expect(phone).not.toBeNull();
    expect(phone!.className).toContain("max-[374px]:gap-1 ");
    expect(phone!.querySelector(".bar-scrim")).not.toBeNull();
    expect(phone!.querySelector('a[href="/en"]')).not.toBeNull();
    expect(phone!.querySelector('a[href="/en"]')!.className).toContain("min-w-11");
    expect(container.querySelector("main")!.parentElement!.className).toContain("pt-[64px]");
    expect(tabBar().className).toContain("grid");
  });
}

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

it.each(["signedOut", "disabled", "signedIn", "loading"])("uses the public brand footer on the portfolio while %s", async (status) => {
  state.pathname = "/portfolio";
  await render(status);
  const footer = container.querySelector("footer")!;
  expect(container.querySelectorAll("footer")).toHaveLength(1);
  expect(footer.querySelector('nav[aria-label="Resources"]')).not.toBeNull();
  expect(footer.querySelector('a[href="/en/about"]')).not.toBeNull();
  expect(footer.querySelector('a[href="/en/privacy"]')).not.toBeNull();
  expect(footer.querySelector('nav[aria-label="Community"]')).not.toBeNull();
  expect(footer.querySelector('button[aria-label="Language"]')).not.toBeNull();
});

it("retains one complete brand footer while the portfolio resolves and changes its login state", async () => {
  state.pathname = "/portfolio";
  for (const status of ["loading", "signedIn", "signedOut", "signedIn"]) {
    await render(status);
    expect(container.querySelectorAll("footer")).toHaveLength(1);
    expect(container.querySelector('footer nav[aria-label="Resources"]')).not.toBeNull();
    expect(container.querySelector('footer a[href="/en/about"]')).not.toBeNull();
    expect(container.querySelector('footer a[href="/en/help"]')).not.toBeNull();
    expect(container.querySelector('footer a[href="/en/terms"]')).not.toBeNull();
    expect(container.querySelector("main")!.textContent).toContain("page");
  }
});

it.each(["/favorites", "/settings", "/settings/account", "/settings/language", "/r/INVITE"])("uses one complete brand footer on %s regardless of login state", async (pathname) => {
  state.pathname = pathname;
  for (const status of ["signedOut", "signedIn", "loading"]) {
    await render(status);
    expect(container.querySelectorAll("footer")).toHaveLength(1);
    expect(container.querySelector('footer nav[aria-label="Resources"]')).not.toBeNull();
    expect(container.querySelector('footer nav[aria-label="Community"]')).not.toBeNull();
    expect(container.querySelector('footer a[href="/en/about"]')).not.toBeNull();
  }
});

it.each(["/trader/0xabc"])("retains the compact legal and help footer on %s", async (pathname) => {
  state.pathname = pathname;
  await render("signedIn");
  expect(container.querySelectorAll("footer")).toHaveLength(1);
  expect(container.querySelector('footer nav[aria-label="Resources"]')).toBeNull();
  expect(container.querySelector('footer a[href="/en/privacy"]')).not.toBeNull();
  expect(container.querySelector('footer a[href="/en/terms"]')).not.toBeNull();
  expect(container.querySelector('footer a[href="/en/help"]')).not.toBeNull();
});

it.each(["signedIn", "signedOut"])("keeps the shared phone header on settings while %s", async (status) => {
  state.pathname = "/settings";
  await render(status);
  const header = container.querySelector('[data-testid="app-phone-header"]');
  expect(header).not.toBeNull();
  expect(header?.querySelector('a[href="/en"]')).not.toBeNull();
});

function measuredLinks(reduce = false) {
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) { return this.tagName === 'A' ? 6 + [...this.parentElement!.querySelectorAll('a')].indexOf(this as HTMLAnchorElement) * 80 : 0; });
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockReturnValue(6);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(80);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(56);
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({matches: reduce && query.includes('prefers-reduced-motion'), addEventListener() {}, removeEventListener() {}})));
}
it('slides the bottom pill to the measured active tab after navigation', async () => {
  measuredLinks(); await render('signedIn');
  const pill = tabBar().querySelector<HTMLElement>('[data-nav-pill]')!;
  expect(pill).not.toBeNull();
  expect(pill.style.transform).toBe('translate3d(86px, 6px, 0)');
  expect(pill.style.transition).toContain('var(--dur-slow)');
  expect(tabBar().querySelector('[aria-current=page]')?.className).not.toContain('bg-primary');
  state.pathname = '/portfolio'; await render('signedIn');
  expect(pill.style.transform).toBe('translate3d(246px, 6px, 0)');
  expect(pill.style.width).toBe('80px');
});
it('switches nav pills immediately when reduced motion is requested', async () => {
  measuredLinks(true); await render('signedOut');
  const pills=container.querySelectorAll<HTMLElement>('[data-nav-pill]');
  expect(pills.length).toBeGreaterThan(0);
  for (const pill of pills) expect(pill.style.transition).toBe('none');
});


it("omits only the trader insights footer and restores it when the tab changes", async () => {
  state.pathname = "/trader/0xabc";
  history.replaceState(null, "", "/trader/0xabc?tab=insights");
  await render("signedIn");
  expect(container.querySelector("footer")).toBeNull();
  await act(async () => {
    history.replaceState(null, "", "/trader/0xabc?tab=trades");
    globalThis.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(container.querySelectorAll("footer")).toHaveLength(1);
  state.pathname = "/insights";
  history.replaceState(null, "", "/insights?tab=insights");
  await render("signedIn");
  expect(container.querySelector('footer nav[aria-label="Resources"]')).not.toBeNull();
});
