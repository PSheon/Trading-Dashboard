// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { BoardCard, BoardMobileRow, HomeCard } from "@/components/discover/board-card";
import { AppShell } from "@/components/shell/app-shell";
import { fixtureHome } from "@/fixtures/discovery";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import type { BoardTrader } from "@/lib/contracts";

/**
 * Explore prefetched 12 trader pages, the home, favorites, portfolio and
 * insights RSC payloads on load (Stage 2026-10-23). Trader cards and the
 * nav links that are not the next step (the lockup, the desktop capsules,
 * the phone menu) are `prefetch={false}`: Next still prefetches them on
 * hover. The phone tab bar keeps prefetching: no hover, and it is the next
 * step.
 */
const state = vi.hoisted(() => ({ status: "signedIn", pathname: "/explore" }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ status: state.status }) }));
vi.mock("next/navigation", async () => { const { routeGroupOf } = await import("./route-group-of"); return { usePathname: () => state.pathname, useSelectedLayoutSegment: () => routeGroupOf(state.pathname), useRouter: () => ({ refresh() {}, push() {} }) }; });
// The project's Link spreads its props onto next/link: the prefetch choice is read off the rendered anchor.
vi.mock("next/link", () => ({ default: ({ children, href, prefetch, ...rest }: { children: React.ReactNode; href: string; prefetch?: boolean } & React.ComponentProps<"a">) => <a href={href} data-prefetch={String(prefetch)} {...rest}>{children}</a> }));
vi.mock("@/components/shell/account-controls", () => ({ AccountControls: () => null, AuthButton: () => null }));
vi.mock("@/components/shell/address-search", () => ({ AddressSearch: () => null }));
vi.mock("@/components/shell/phone-menu", () => ({ PhoneMenu: () => null }));
vi.mock("@/components/shell/announcement-banner", () => ({ AnnouncementBanner: () => null }));
vi.mock("@/components/shell/maintenance-banner", () => ({ MaintenanceBanner: () => null }));
vi.mock("@/components/copy/copy-feed", () => ({ CopyFeed: () => null }));
vi.mock("@/lib/queries", () => ({ useSiteSettings: () => ({ data: undefined }) }));
vi.mock("@/components/wallet/wallet-modals", () => ({ WalletModalsProvider: ({ children }: { children: React.ReactNode }) => children }));

const NOW = Date.parse("2026-10-12T12:00:00Z");
const sample = fixtureHome().calculator[0];
const trader: BoardTrader = { ...sample, lastTradeAt: sample.lastTradeAt?.toISOString() ?? null, tradesFrom: sample.tradesFrom?.toISOString() ?? null, metricsUpdatedAt: null } as unknown as BoardTrader;

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  history.replaceState(null, "", "/");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = (node: React.ReactNode) => act(async () => root.render(<I18nProvider locale="en" messages={en}>{node}</I18nProvider>));
const prefetchOf = (scope: ParentNode, selector: string) => [...scope.querySelectorAll<HTMLAnchorElement>(selector)].map((a) => [a.getAttribute("href"), a.dataset.prefetch] as const);

it("trader cards do not prefetch their trader page", async () => {
  await render(<><BoardCard trader={trader} pnlLabel="PnL" roiLabel="ROI" now={NOW} /><HomeCard trader={trader} /><ul><BoardMobileRow trader={trader} /></ul></>);
  const links = prefetchOf(container, 'a[href*="/trader/"]');
  expect(links).toHaveLength(3);
  for (const [, prefetch] of links) expect(prefetch).toBe("false");
});

it("the shell prefetches the phone tab bar only; the lockup and the desktop capsules wait for hover", async () => {
  await render(<AppShell><p>page</p></AppShell>);
  const lockups = prefetchOf(container, 'header a[href="/en"]');
  expect(lockups).toHaveLength(2);
  for (const [, prefetch] of lockups) expect(prefetch).toBe("false");
  const capsules = prefetchOf(container.querySelector("header.orbit-header")!, "nav a");
  expect(capsules.map(([href]) => href)).toEqual(["/en/explore", "/en/insights", "/en/portfolio", "/en/favorites"]);
  for (const [, prefetch] of capsules) expect(prefetch).toBe("false");
  const tabs = prefetchOf(container.querySelector("nav.phone-floating-bar")!, "a");
  expect(tabs.length).toBeGreaterThan(0);
  for (const [, prefetch] of tabs) expect(prefetch).toBe("undefined");
});
