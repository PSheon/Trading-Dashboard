"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";

import { Lockup, OrbieMark } from "@/components/brand/logo";
import { useT } from "@/i18n/provider";
import { useIsAdmin } from "@/lib/auth";
import { APP_NAME } from "@/lib/config";
import { AnnouncementBanner } from "./announcement-banner";
import { AccountControls } from "./account-controls";
import { AddressSearch } from "./address-search";
import { WalletModalsProvider } from "@/components/wallet/wallet-modals";
import { adminNav, isActive, mobileNav, primaryNav, type NavItem } from "./nav";

const BARE_PAGES = new Set(["/privacy", "/terms", "/delete-account"]);

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
  const ownPhoneHeader = traderPage || barePhonePage || pathname === "/portfolio";

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

      <header
        className={cn(
          ownPhoneHeader ? "hidden md:flex" : "flex",
          "fixed inset-x-0 top-0 z-40 h-16 items-center gap-3 border-b border-border bg-background/95 px-3 md:h-[72px] md:bg-background/90 md:backdrop-blur-xl md:gap-6 md:px-5",
        )}
      >
        <Link href="/" className="flex shrink-0 items-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Lockup className="hidden sm:inline-flex" />
          <OrbieMark size={32} className="sm:hidden" title={APP_NAME} />
        </Link>
        <div className="flex min-w-0 flex-1 justify-center">
          <AddressSearch />
        </div>
        <AccountControls />
      </header>

      <nav
        aria-label={t("nav.primary")}
        className="fixed top-[72px] bottom-0 left-0 z-30 hidden w-[76px] flex-col items-center gap-1 border-r border-border bg-background py-3 md:flex"
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
              : ownPhoneHeader
              ? "pt-0 pb-[calc(68px+env(safe-area-inset-bottom))]"
              : "pt-16 pb-[calc(68px+env(safe-area-inset-bottom))]",
          "md:pt-[72px] md:pb-0 md:pl-[76px]",
        )}
      >
        <AnnouncementBanner />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1600px] px-5 py-5 md:px-8 md:py-7">
          {children}
        </main>
      </div>

      <nav
        aria-label={t("nav.primary")}
        className={cn(
          "fixed inset-x-0 bottom-0 z-30 grid-cols-4 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden",
          traderPage || barePhonePage ? "hidden" : "grid",
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
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex w-[62px] flex-col items-center gap-1 rounded-2xl py-2.5 text-[0.6875rem] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-raised text-foreground" : "text-muted-foreground hover:bg-raised/60 hover:text-foreground",
      )}
    >
      <Icon
        className={cn("size-[22px] transition-colors", active ? "text-primary" : "")}
        strokeWidth={active ? 2.25 : 1.75}
      />
      <span className="leading-tight">{t(item.label)}</span>
    </Link>
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
        "flex h-[60px] flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium",
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Icon className={cn("size-[22px]", active ? "text-primary" : "")} strokeWidth={active ? 2.25 : 1.75} />
      {t(item.label)}
    </Link>
  );
}
