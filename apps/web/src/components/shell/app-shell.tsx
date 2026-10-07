"use client";

import { useSlidingIndicator } from "@/lib/use-sliding-indicator";
import { prefersReducedMotion } from "@/lib/motion";
import { usePageScrolled } from "@/lib/use-page-scrolled";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "cn";

import { Lockup } from "@/components/brand/logo";
import { useT } from "@/i18n/provider";
import { APP_NAME } from "@/lib/config";
import { AnnouncementBanner } from "./announcement-banner";
import { MaintenanceBanner } from "./maintenance-banner";
import { CopyFeed } from "@/components/copy/copy-feed";
import { AccountControls, AuthButton } from "./account-controls";
import { AddressSearch } from "./address-search";
import { ModeBadge } from "./mode-badge";
import { PhoneMenu } from "./phone-menu";
import { SiteFooter } from "./site-footer";
import { WalletModalsProvider } from "@/components/wallet/wallet-modals";
import { useAuth } from "@/lib/auth";
import type { PublicSettings } from "@/lib/contracts";
import { type InitialRead, useSiteSettings } from "@/lib/queries";
import { discoverNav, isActive, mineNav, mobileNav, mobileNavSignedOut, type NavItem } from "./nav";
import { IslandBoundary } from "@/components/island-boundary";

/** Every route the app serves; anything else is the 404 page. */
const ROUTES = ["/explore", "/favorites", "/insights", "/portfolio", "/settings", "/coins", "/trader", "/admin", "/about", "/help", "/dev"];
const isAppRoute = (pathname: string) => pathname === "/" || ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));

/**
 * Phone chrome differs per page (Orbit's M boards):
 * - home and the main browsing/personal pages: the wordmark, search and
 *   登入 / the account, with the floating bottom navigation;
 * - about, help and the 404 page: wordmark, search and the ☰ menu, with no
 *   tab bar;
 * - detail/settings pages keep their own page chrome.
 */
function phoneChrome(pathname: string): "home" | "marketing" | "none" {
  if (pathname === "/" || ["/explore", "/favorites", "/portfolio", "/insights"].some(r => pathname === r || pathname.startsWith(`${r}/`))) return "home";
  if (pathname === "/about" || pathname === "/help" || !isAppRoute(pathname)) return "marketing";
  return "none";
}

/**
 * Pages that end in the site footer from the shell (home, about and help
 * draw their own). Browsing pages that search engines index get it on
 * desktop and tablet; on phones their tab bar is the navigation, as on the
 * home page. The legal pages, which have no tab bar, get it everywhere. The
 * trader page and the personal pages (portfolio, favorites, settings),
 * admin and /dev end without one, as on CopyDog.
 */
function shellFooter(pathname: string): "everywhere" | "desktop" | null {
  if (["/privacy", "/terms", "/delete-account"].includes(pathname)) return "everywhere";
  if (["/explore", "/insights", "/coins"].includes(pathname) || pathname.startsWith("/coins/")) return "desktop";
  return null;
}

/**
 * Orbit frame. No sidebar: on desktop and tablet a three-column header —
 * wordmark and the 探索 / 洞察 capsule, the search centred, the 投資組合 /
 * 收藏 capsule with language, theme and the account on the right. On phones
 * a floating capsule tab bar at the bottom.
 *
 * 投資組合 / 收藏 are the visitor's own pages: they show once someone is
 * signed in, never while signed out or while sign-in is still unknown (the
 * signed-out header is drawn until then, and the capsule fades in).
 */
export function AppShell({
  children,
  settings,
  announcementDismissed,
}: {
  children: React.ReactNode;
  /** GET /settings as the server read it: the banners are in the first
   * HTML instead of pushing the page down when the browser's read lands. */
  settings?: InitialRead<PublicSettings> | null;
  /** The dismissed announcement's hash (cookie). */
  announcementDismissed?: string | null;
}) {
  const t = useT();
  const pathname = usePathname();
  // At the top of the page the bars are clear; once it scrolls, their
  // frosted panel (.bar-scrim) fades in.
  const scrolled = usePageScrolled();
  const signedIn = useAuth().status === "signedIn";
  const [mobileRef, mobileBox] = useSlidingIndicator<HTMLElement>(`${pathname}:${signedIn}`);
  const mobilePill = mobileBox?.width ? mobileBox : null;
  // Seeds the query the banners (and pages) read, before they mount.
  useSiteSettings(settings);
  // A trader page on a phone has its own top bar and a sticky 跟單 button in
  // place of the header and the tab bar.
  const traderPage = pathname.startsWith("/trader/");
  // The 市場 pages are bare on a phone: no top bar and no tab bar, only the
  // page and its breadcrumb.
  const barePhonePage = pathname === "/coins" || pathname.startsWith("/coins/");
  const chrome = phoneChrome(pathname);
  const footer = shellFooter(pathname);

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

      {/* The bar's background spans the window; its contents sit in the
          page frame, so they line up with the page below. Three equal
          columns, the sides never narrower than their contents: the search
          (at most 400px) sits in the middle one, centred on the page
          whenever both sides fit a third, as they do signed out or in. */}
      <header data-scrolled={scrolled} className="orbit-header sticky top-0 z-40 isolate hidden md:block">
        <div aria-hidden className="bar-scrim" />
        <div className="page-frame grid grid-cols-[minmax(max-content,1fr)_minmax(0,1fr)_minmax(max-content,1fr)] items-center gap-3 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            aria-label={`${APP_NAME} ${t("nav.home")}`}
            className="flex h-[52px] shrink-0 items-center rounded-full pr-2 pl-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Lockup />
          </Link>
          <IslandBoundary><ModeBadge className="-ml-2" /></IslandBoundary>
          <NavCapsule label={t("nav.primary")} items={discoverNav} pathname={pathname} />
        </div>
        <div className="flex min-w-0 justify-center">
          <IslandBoundary><AddressSearch /></IslandBoundary>
        </div>
        <div className="flex min-w-0 items-center justify-end gap-3">
          {signedIn ? (
            <NavCapsule
              label={t("nav.mine")}
              items={mineNav}
              pathname={pathname}
              className="animate-in duration-300 fade-in-0 motion-reduce:animate-none"
            />
          ) : null}
          <IslandBoundary><AccountControls /></IslandBoundary>
        </div>
        </div>
      </header>
      {/* No backdrop-filter on the header itself (it would become the
          containing block of the full-screen search overlay inside it); the
          blur lives on its .bar-scrim child. */}
      {chrome !== "none" ? (
        <header data-testid="app-phone-header" data-scrolled={scrolled} className="fixed inset-x-0 top-0 z-40 isolate flex h-[72px] items-center gap-2 px-4 max-[374px]:gap-1 max-[374px]:px-3 md:hidden">
          <div aria-hidden className="bar-scrim" />
          <Link href="/" aria-label={APP_NAME} className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Lockup className="[&>span]:text-2xl max-[374px]:[&>span]:hidden" />
          </Link>
          <IslandBoundary><ModeBadge className="mr-auto" /></IslandBoundary>
          <IslandBoundary><AddressSearch compact /></IslandBoundary>
          <IslandBoundary>{chrome === "marketing" ? <PhoneMenu /> : <AuthButton compact />}</IslandBoundary>
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
        {/* Each island of the shell fails on its own (web audit H5). */}
        <IslandBoundary><MaintenanceBanner /></IslandBoundary>
        <IslandBoundary><AnnouncementBanner dismissed={announcementDismissed} /></IslandBoundary>
        <IslandBoundary><CopyFeed /></IslandBoundary>
        <main
          id="main"
          tabIndex={-1}
          className={cn(
            // overflow-x-clip: row scroll arrows hang half outside their
            // row; without the clip they add a few px of page scroll.
            "page-frame overflow-x-clip py-4 outline-none md:pt-2 md:pb-10",
            traderPage && "md:pb-14",
          )}
        >
          {children}
          {footer ? <SiteFooter className={footer === "desktop" ? "hidden md:flex" : "mt-16"} /> : null}
        </main>
      </div>

      <nav
        ref={mobileRef}
        aria-label={t("nav.primary")}
        className={cn(
          "phone-floating-bar z-30 gap-1 md:hidden",
          signedIn ? "grid-cols-4" : "grid-cols-3",
          tabBar ? "grid" : "hidden",
        )}
      >
        <NavPill box={mobilePill} />
        {(signedIn ? mobileNav : mobileNavSignedOut).map((item) => (
          <TabLink key={item.href} item={item} active={isActive(pathname, item.href)} measured={Boolean(mobilePill)} />
        ))}
      </nav>
    </div>
    </WalletModalsProvider>
  );
}

/** A raised capsule of links; the current page is the orange pill. Labels
 * show from 1400px, icons only below (T1024 / T820 boards). */
function NavCapsule({ label, items, pathname, className }: { label: string; items: NavItem[]; pathname: string; className?: string }) {
  const t = useT();
  const [ref, box] = useSlidingIndicator<HTMLElement>(pathname);
  const pill = box?.width ? box : null;
  return (
    <nav ref={ref} aria-label={label} className={cn("relative isolate flex shrink-0 gap-0.5 rounded-[26px] bg-raised p-1", className)}>
      <NavPill box={pill} />
      {items.map((item) => {
        const Icon = item.icon;
        const active = isActive(pathname, item.href);
        const text = t(item.label);
        return (
          <Link
            key={item.href}
            href={item.href}
            data-active={active}
            aria-current={active ? "page" : undefined}
            aria-label={text}
            title={text}
            className={cn(
              "orbit-press relative z-10 flex h-11 items-center gap-2 rounded-[22px] px-3.5 font-extrabold whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring min-[1400px]:px-4",
              active ? cn("text-primary-foreground", !pill && "bg-primary") : "text-muted-foreground hover:bg-raised-hover hover:text-foreground",
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

function TabLink({ item, active, measured }: { item: NavItem; active: boolean; measured: boolean }) {
  const t = useT();
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      data-active={active}
      aria-current={active ? "page" : undefined}
      className={cn(
        "orbit-press relative z-10 flex min-w-0 flex-col items-center justify-center gap-1 rounded-[28px] px-1 text-[11px] leading-none font-extrabold outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? cn("text-primary-foreground", !measured && "bg-primary") : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-5" strokeWidth={2.4} aria-hidden />
      <span className="max-w-full truncate">{t(item.label)}</span>
    </Link>
  );
}

function NavPill({ box }: { box: {left:number;top:number;width:number;height:number} | null }) {
  if (!box) return null;
  return <span aria-hidden data-nav-pill className="pointer-events-none absolute top-0 left-0 rounded-full bg-primary motion-reduce:transition-none!"
    style={{transform:`translate3d(${box.left}px, ${box.top}px, 0)`,width:box.width,height:box.height,transition:prefersReducedMotion() ? "none" : "transform var(--dur-slow) var(--ease-orbit), width var(--dur-slow) var(--ease-orbit), height var(--dur-slow) var(--ease-orbit)"}} />;
}
