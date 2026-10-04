"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";

import { Lockup } from "@/components/brand/logo";
import { useT } from "@/i18n/provider";
import { APP_NAME } from "@/lib/config";
import { AnnouncementBanner } from "./announcement-banner";
import { MaintenanceBanner } from "./maintenance-banner";
import { CopyFeed } from "@/components/copy/copy-feed";
import { AccountControls, AuthButton } from "./account-controls";
import { AddressSearch } from "./address-search";
import { PhoneMenu } from "./phone-menu";
import { WalletModalsProvider } from "@/components/wallet/wallet-modals";
import { discoverNav, isActive, mineNav, mobileNav, type NavItem } from "./nav";

/** Every route the app serves; anything else is the 404 page. */
const ROUTES = ["/explore", "/favorites", "/insights", "/portfolio", "/settings", "/coins", "/trader", "/admin", "/about", "/help", "/dev"];
const isAppRoute = (pathname: string) => pathname === "/" || ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));

/**
 * Phone chrome differs per page (Orbit's M boards):
 * - home: the wordmark, a round search button and 登入 / the account;
 * - about, help and the 404 page: wordmark, search and the ☰ menu, with no
 *   tab bar;
 * - every other page: no top bar at all, only the page's own title.
 */
function phoneChrome(pathname: string): "home" | "marketing" | "none" {
  if (pathname === "/") return "home";
  if (pathname === "/about" || pathname === "/help" || !isAppRoute(pathname)) return "marketing";
  return "none";
}

/**
 * Orbit frame. No sidebar: on desktop and tablet a three-column header —
 * wordmark and the 探索 / 洞察 capsule, the search centred, the 投資組合 /
 * 收藏 capsule with language, theme and the account on the right. On phones
 * a floating capsule tab bar at the bottom.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const t = useT();
  const pathname = usePathname();
  // A trader page on a phone has its own top bar and a sticky 跟單 button in
  // place of the header and the tab bar.
  const traderPage = pathname.startsWith("/trader/");
  // The 市場 pages are bare on a phone: no top bar and no tab bar, only the
  // page and its breadcrumb.
  const barePhonePage = pathname === "/coins" || pathname.startsWith("/coins/");
  const chrome = phoneChrome(pathname);

  // The design lab owns its frame; the production shell stays unchanged.
  if (pathname === "/dev" || pathname.startsWith("/dev/")) return <>{children}</>;

  const tabBar = !(traderPage || barePhonePage || chrome === "marketing");

  return (
    <WalletModalsProvider>
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-primary px-4 py-2 font-extrabold text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t("nav.skip")}
      </a>

      <header className="orbit-header sticky top-0 z-40 hidden grid-cols-[auto_minmax(0,1fr)_auto] items-center xl:grid-cols-[minmax(0,1fr)_minmax(200px,400px)_minmax(0,1fr)] gap-3 bg-background/92 px-5 py-3 backdrop-blur-xl md:grid">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            aria-label={`${APP_NAME} ${t("nav.home")}`}
            className="flex h-[52px] shrink-0 items-center rounded-full pr-2 pl-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Lockup />
          </Link>
          <NavCapsule label={t("nav.primary")} items={discoverNav} pathname={pathname} />
        </div>
        <div className="flex min-w-0 justify-center">
          <AddressSearch />
        </div>
        <div className="flex min-w-0 items-center justify-end gap-3">
          <NavCapsule label={t("nav.mine")} items={mineNav} pathname={pathname} />
          <AccountControls />
        </div>
      </header>
      {/* Solid, without backdrop-filter: a filter would make the phone header
          the containing block of the full-screen search overlay inside it. */}
      {chrome !== "none" ? (
        <header className="fixed inset-x-0 top-0 z-40 flex h-[72px] items-center gap-2.5 bg-background px-4 md:hidden">
          <Link href="/" aria-label={APP_NAME} className="mr-auto flex shrink-0 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Lockup />
          </Link>
          <AddressSearch compact />
          {chrome === "marketing" ? <PhoneMenu /> : <AuthButton compact />}
        </header>
      ) : null}

      <div
        className={cn(
          traderPage
            ? "pt-0 pb-[calc(96px+env(safe-area-inset-bottom))]"
            : barePhonePage
              ? "pt-4 pb-10"
              : chrome === "marketing"
                ? "pt-[72px] pb-10"
                : chrome === "home"
                  ? "pt-[64px] pb-[calc(100px+env(safe-area-inset-bottom))]"
                  : "pt-0 pb-[calc(100px+env(safe-area-inset-bottom))]",
          "md:pt-0 md:pb-0",
        )}
      >
        <MaintenanceBanner />
        <AnnouncementBanner />
        <CopyFeed />
        <main
          id="main"
          tabIndex={-1}
          className={cn(
            // overflow-x-clip: row scroll arrows hang half outside their
            // row; without the clip they add a few px of page scroll.
            "mx-auto w-full max-w-[1600px] overflow-x-clip px-4 py-4 outline-none md:px-5 md:pt-2 md:pb-10",
            traderPage && "md:pb-14",
          )}
        >
          {children}
        </main>
      </div>

      <nav
        aria-label={t("nav.primary")}
        className={cn(
          "fixed inset-x-3 bottom-[calc(12px+env(safe-area-inset-bottom))] z-30 h-[68px] grid-cols-4 gap-1 rounded-4xl bg-raised p-1.5 shadow-[0_10px_30px_-12px_rgb(21_19_43/35%)] md:hidden",
          tabBar ? "grid" : "hidden",
        )}
      >
        {mobileNav.map((item) => (
          <TabLink key={item.href} item={item} active={isActive(pathname, item.href)} />
        ))}
      </nav>
    </div>
    </WalletModalsProvider>
  );
}

/** A raised capsule of links; the current page is the orange pill. Labels
 * show from 1400px, icons only below (T1024 / T820 boards). */
function NavCapsule({ label, items, pathname }: { label: string; items: NavItem[]; pathname: string }) {
  const t = useT();
  return (
    <nav aria-label={label} className="flex shrink-0 gap-0.5 rounded-[26px] bg-raised p-1">
      {items.map((item) => {
        const Icon = item.icon;
        const active = isActive(pathname, item.href);
        const text = t(item.label);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            aria-label={text}
            title={text}
            className={cn(
              "orbit-press flex h-11 items-center gap-2 rounded-[22px] px-3.5 font-extrabold whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring min-[1400px]:px-4",
              active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-raised-hover hover:text-foreground",
            )}
          >
            <Icon className="size-[18px]" strokeWidth={2.4} aria-hidden />
            <span className="hidden min-[1400px]:inline">{text}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function TabLink({ item, active }: { item: NavItem; active: boolean }) {
  const t = useT();
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "orbit-press flex min-w-0 flex-col items-center justify-center gap-1 rounded-[28px] px-1 text-[11px] leading-none font-extrabold outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-5" strokeWidth={2.4} aria-hidden />
      <span className="max-w-full truncate">{t(item.label)}</span>
    </Link>
  );
}
