"use client";

import { useSlidingIndicator } from "@/lib/use-sliding-indicator";
import { prefersReducedMotion } from "@/lib/motion";
import { useUrlState } from "@/lib/url-state";
import { usePageScrolled } from "@/lib/use-page-scrolled";
import { Link, usePathname } from "@/i18n/navigation";
import { useSelectedLayoutSegment } from "next/navigation";
import { cn } from "cn";
import * as React from "react";

import { Lockup } from "@/components/brand/logo";
import { useT } from "@/i18n/provider";
import { APP_NAME } from "@/lib/config";
import { AnnouncementBanner } from "./announcement-banner";
import { MaintenanceBanner } from "./maintenance-banner";
import { CopyFeed } from "@/components/copy/copy-feed";
import { AccountControls, AuthButton } from "./account-controls";
import { AddressSearch } from "./address-search";
import { PhoneMenu } from "./phone-menu";
import { SiteFooter } from "./site-footer";
import { WalletModalsProvider } from "@/components/wallet/wallet-modals";
import { useAuth } from "@/lib/auth";
import type { PublicSettings } from "@/lib/contracts";
import { type InitialRead, useSiteSettings } from "@/lib/queries";
import { discoverNav, isActive, mineNav, mobileNav, mobileNavSignedOut, type NavItem } from "./nav";
import { IslandBoundary } from "@/components/island-boundary";
import { chromeFor } from "./chrome";

/** React's <ViewTransition>: in the App Router's bundled React, absent from
 * the plain react package (tests) and in browsers without view transitions,
 * where the page simply changes without motion. */
const ReactViewTransition = (React as unknown as { ViewTransition?: React.ComponentType<{ name?: string; share?: string; enter?: string; exit?: string; default?: string; children: React.ReactNode }> }).ViewTransition;

/** The page content, faded in when the visitor moves to another section
 * (探索 → 收藏, a trader → 投資組合): keyed by the first path segment, so tabs
 * and sub-pages of one section change in place. The header, tab bar and
 * footer stay still (they are outside it). */
function PageTransition({ children }: { children: React.ReactNode }) {
  if (!ReactViewTransition) return <>{children}</>;
  return <ReactViewTransition name="page-content" share="page-swap" enter="page-swap" exit="page-swap" default="none">{children}</ReactViewTransition>;
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
 *
 * What else a page gets (the phone top bar, the tab bar, the footer) is its
 * route group's chrome (./chrome.ts): the frame reads the active group, so
 * it stays mounted when the visitor moves between groups.
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
  const authStatus = useAuth().status;
  const signedIn = authStatus === "signedIn";
  const chrome = chromeFor(useSelectedLayoutSegment());
  const fill = Boolean(chrome?.fill);
  const guestFill = fill && (authStatus === "signedOut" || authStatus === "disabled");
  const [mobileRef, mobileBox] = useSlidingIndicator<HTMLElement>(`${pathname}:${signedIn}`);
  const mobilePill = mobileBox?.width ? mobileBox : null;
  // Seeds the query the banners (and pages) read, before they mount.
  useSiteSettings(settings);
  const [tab] = useUrlState("tab", ["positions", "insights"], "positions");
  const footer = Boolean(chrome?.footer) && !(chrome?.noFooterOnInsightsTab && tab === "insights");

  // The design lab owns its frame; the production shell stays unchanged.
  if (!chrome) return <>{children}</>;

  return (
    <WalletModalsProvider>
    <div className={cn("min-h-dvh", fill && "md:flex md:flex-col")}>
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
      {chrome.phoneHeader ? (
        <header data-testid="app-phone-header" data-scrolled={scrolled} className="fixed inset-x-0 top-0 z-40 isolate flex h-[72px] items-center gap-2 px-4 max-[374px]:gap-1 max-[374px]:px-3 md:hidden">
          <div aria-hidden className="bar-scrim" />
          <Link href="/" aria-label={APP_NAME} className="mr-auto flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Lockup className="[&>span]:text-2xl max-[479px]:[&>span]:hidden" />
          </Link>
          <IslandBoundary><AddressSearch compact /></IslandBoundary>
          <IslandBoundary>{chrome.phoneHeader === "menu" ? <PhoneMenu /> : <AuthButton compact />}</IslandBoundary>
        </header>
      ) : null}

      <div
        className={cn(chrome.phonePad, "md:pt-0 md:pb-0", fill && "md:flex md:flex-1 md:flex-col")}
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
            chrome.main,
            fill && "md:flex md:flex-1 md:flex-col md:pb-6",
          )}
        >
          <PageTransition key={pathname.split("/")[1] ?? ""}>
            {guestFill ? <div className="md:flex md:flex-1 md:items-center md:justify-center md:py-3">{children}</div> : fill ? <div className="md:flex-1">{children}</div> : children}
          </PageTransition>
          {footer ? <SiteFooter className={guestFill ? "mt-10 md:mt-0 md:shrink-0" : fill ? "mt-10 md:mt-8 md:shrink-0" : "mt-16"} /> : null}
        </main>
      </div>

      <nav
        ref={mobileRef}
        aria-label={t("nav.primary")}
        className={cn(
          "phone-floating-bar z-30 gap-1 md:hidden",
          signedIn ? "grid-cols-4" : "grid-cols-3",
          chrome.tabBar ? "grid" : "hidden",
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
