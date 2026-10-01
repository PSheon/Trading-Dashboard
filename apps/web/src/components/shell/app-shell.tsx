"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";

import { Lockup } from "@/components/brand/logo";
import { useT } from "@/i18n/provider";
import { useIsAdmin } from "@/lib/auth";
import { APP_NAME } from "@/lib/config";
import { AnnouncementBanner } from "./announcement-banner";
import { AccountControls } from "./account-controls";
import { AddressSearch } from "./address-search";
import { PhoneMenu } from "./phone-menu";
import { WalletModalsProvider } from "@/components/wallet/wallet-modals";
import { adminNav, isActive, mobileNav, primaryNav, type NavItem } from "./nav";

const BARE_PAGES = new Set(["/privacy", "/terms", "/delete-account"]);

/** Every route the app serves; anything else is the 404 page. */
const ROUTES = ["/explore", "/favorites", "/insights", "/portfolio", "/settings", "/coins", "/trader", "/admin", "/about", "/help", "/dev"];
const isAppRoute = (pathname: string) => pathname === "/" || ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));

/**
 * CopyDog's phone chrome differs per page:
 * - home: the wordmark and a search icon (登入 sits beside the title);
 * - about, help and the 404 page (its marketing pages): wordmark, search
 *   and a menu, with no tab bar;
 * - every other page: no top bar at all, only the page's own title.
 */
function phoneChrome(pathname: string): "home" | "marketing" | "none" {
  if (pathname === "/") return "home";
  if (pathname === "/about" || pathname === "/help" || !isAppRoute(pathname)) return "marketing";
  return "none";
}

/**
 * CopyDog-style frame: full-width top bar (lockup, wide address search,
 * language, login), a 76 px icon rail with labels under the icons on
 * desktop, and a bottom tab bar on phones.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const t = useT();
  const pathname = usePathname();
  const isAdmin = useIsAdmin();
  // A trader page on a phone has its own top bar and a sticky 跟單 button in
  // place of the header and the tab bar, as on CopyDog's app.
  const traderPage = pathname.startsWith("/trader/");
  // CopyDog's 市場 pages are bare on a phone: no top bar and no tab bar,
  // only the page and its breadcrumb.
  const barePhonePage = pathname === "/coins" || pathname.startsWith("/coins/");
  // CopyDog's phone portfolio has its own title bar (投資組合, bell, gear).
  const chrome = phoneChrome(pathname);

  // CopyDog's legal pages are plain documents: no top bar, rail or tabs.
  if (BARE_PAGES.has(pathname)) {
    return (
      <main id="main" tabIndex={-1} className="min-h-dvh outline-none">
        {children}
      </main>
    );
  }

  // The design lab owns its frame; the production shell stays unchanged.
  if (pathname === "/dev" || pathname.startsWith("/dev/")) return <>{children}</>;

  return (
    <WalletModalsProvider>
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t("nav.skip")}
      </a>

      <header className="fixed inset-x-0 top-0 z-40 hidden h-[81px] items-center gap-6 border-b border-border bg-background/90 px-4 backdrop-blur-xl md:flex">
        <Link href="/" className="flex shrink-0 items-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Lockup />
        </Link>
        <div className="flex min-w-0 flex-1 justify-center">
          <AddressSearch />
        </div>
        <AccountControls />
      </header>
      {chrome !== "none" ? (
        <header className="fixed inset-x-0 top-0 z-40 flex h-16 items-center gap-2 bg-background px-5 md:hidden">
          <Link href="/" aria-label={APP_NAME} className="mr-auto flex shrink-0 items-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Lockup />
          </Link>
          <AddressSearch compact buttonClassName={chrome === "marketing" ? "bg-raised" : "-mr-2"} />
          {chrome === "marketing" ? <PhoneMenu /> : null}
        </header>
      ) : null}

      <nav
        aria-label={t("nav.primary")}
        className="fixed top-[81px] bottom-0 left-0 z-30 hidden w-[76px] flex-col items-center gap-0.5 border-r border-border bg-background px-2 pt-3 pb-4 md:flex"
      >
        {primaryNav.map((item) => (
          <RailLink key={item.href} item={item} active={isActive(pathname, item.href)} />
        ))}
        <div className="mt-auto flex flex-col items-center gap-1">
          {/* No 設定 here, as on CopyDog: settings open from the avatar
              menu (desktop) and the portfolio gear (phone). */}
          {isAdmin ? <RailLink item={adminNav} active={isActive(pathname, adminNav.href)} /> : null}
        </div>
      </nav>

      <div
        className={cn(
          traderPage
            ? "pt-0 pb-[calc(84px+env(safe-area-inset-bottom))]"
            : barePhonePage
              ? "pt-4 pb-10"
              : chrome === "marketing"
                ? "pt-16 pb-10"
                : chrome === "home"
                  ? "pt-[58px] pb-[calc(68px+env(safe-area-inset-bottom))]"
                  : "pt-0 pb-[calc(68px+env(safe-area-inset-bottom))]",
          "md:pt-[81px] md:pb-0 md:pl-[76px]",
        )}
      >
        <AnnouncementBanner />
        {/* CopyDog's .hl-page: 32px around with 16px on the right; its
            trader page sits 8px from the frame. */}
        <main
          id="main"
          tabIndex={-1}
          className={cn(
            // overflow-x-clip: the row scroll arrows hang half outside their
            // row (as CopyDog's do); without the clip they add 3px of page scroll.
            "mx-auto w-full max-w-[1600px] overflow-x-clip px-5 py-5",
            traderPage ? "md:px-2 md:pt-2 md:pb-14" : pathname.startsWith("/admin") ? "md:px-8 md:py-7" : "md:pt-8 md:pr-4 md:pb-8 md:pl-8",
          )}
        >
          {children}
        </main>
      </div>

      <nav
        aria-label={t("nav.primary")}
        className={cn(
          "fixed inset-x-0 bottom-0 z-30 h-[calc(56px+env(safe-area-inset-bottom))] grid-cols-4 border-t-[0.5px] border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden",
          traderPage || barePhonePage || chrome === "marketing" ? "hidden" : "grid",
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

function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  const t = useT();
  const Icon = item.icon;
  // CopyDog's .hl-siderail__item: 12px radius, 11px × 2px padding, 21px
  // icon, 10px / 600 label; active is the raised fill in white.
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex w-[60px] flex-col items-center gap-[5px] rounded-[12px] px-0.5 py-[11px] text-[10px] leading-[15px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-raised text-foreground hover:bg-raised-hover" : "text-muted-foreground hover:bg-raised hover:text-foreground",
      )}
    >
      <Icon className="size-[21px]" strokeWidth={active ? 2 : 1.75} fill={active && item.fillable ? "currentColor" : "none"} />
      <span className="whitespace-nowrap">{t(item.label)}</span>
    </Link>
  );
}

function TabLink({ item, active }: { item: NavItem; active: boolean }) {
  const t = useT();
  const Icon = item.icon;
  // CopyDog's .hl-bottomnav__item: 24px icons, 10px labels; the active tab
  // in the brand colour; house, star and pie are always solid there.
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-11 flex-col items-center justify-center gap-1 px-1 py-1.5 text-[10px] leading-none transition-colors",
        active ? "font-semibold text-primary" : "font-medium text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-6" strokeWidth={active ? 2 : 1.75} fill={item.fillable ? "currentColor" : "none"} />
      <span className="max-w-full truncate">{t(item.label)}</span>
    </Link>
  );
}
