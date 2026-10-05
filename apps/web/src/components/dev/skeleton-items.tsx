"use client";

import { AdminBodySkeleton, AdminShell } from "@/components/admin/admin-shell";
import { AdminCopyStatus } from "@/components/admin/copy/status";
import { AdminOverview } from "@/components/admin/overview";
import { AdminUsers } from "@/components/admin/users";
import { CoinBoardView, CoinIndexSkeleton, CoinIndexView } from "@/components/coins/coins-view";
import { BoardsView } from "@/components/explore/boards-view";
import { FavoritesView } from "@/components/favorites/favorites-view";
import { HomeSkeleton, HomeView } from "@/components/home/home-view";
import { InsightsView } from "@/components/insights/insights-view";
import { PortfolioView } from "@/components/portfolio-view";
import { SettingsView } from "@/components/settings/settings-view";
import { AddressSearch } from "@/components/shell/address-search";
import { ActivityTabsSkeleton } from "@/components/trader/activity-tabs";
import { MobileTraderSkeleton } from "@/components/trader/mobile-trader";
import { Loading, TradesTab } from "@/components/trader/trade-analytics";
import { FILL_COLS, OrdersTab, TransfersTab, TwapTab } from "@/components/trader/trader-tabs";
import { TraderView } from "@/components/trader/trader-view";
import { DepositDialog } from "@/components/wallet/deposit-dialog";
import { FundsHistory } from "@/components/wallet/funds-history";
import { WithdrawDialog } from "@/components/wallet/withdraw-dialog";
import { useI18n } from "@/i18n/provider";

/**
 * Every route's and component's loading state for the skeleton gallery
 * (/<locale>/dev/skeletons). Each item renders the real component: in the
 * "skeleton" state its frame holds the network (React Query paused
 * offline), so it shows exactly the loading state a visitor sees; in the
 * "loaded" state the same component reads its data as the app does (the
 * fixtures under NEXT_PUBLIC_API_FIXTURES=1, the local api otherwise, and
 * this browser's session for the personal pages). `skeleton` is the route's
 * own fallback (a loading.tsx or Suspense fallback) where that is a
 * different component from the page.
 */
export interface SkeletonItem {
  id: string;
  group: string;
  label: string;
  /** Extra query for the frame (a page's URL state: ?view=list, ?tab=…). */
  query?: string;
  /** The frame's height in CSS pixels at its own width. */
  height: number;
  /** A phone-only layout keeps its width whatever the preset. */
  width?: number;
  view: (ctx: { address: string }) => React.ReactNode;
  skeleton?: (ctx: { address: string }) => React.ReactNode;
}

const PAGE = 900;
const noop = () => {};

function Page({ children }: { children: React.ReactNode }) {
  // The app's page frame, as the shell lays it out (without its bars).
  return <main className="page-frame py-6">{children}</main>;
}

function FillsLoading() {
  const { t } = useI18n();
  return <Loading cols={FILL_COLS.map((k) => t(`trader.cols.${k}`))} />;
}

export const SKELETON_ITEMS: SkeletonItem[] = [
  { id: "home", group: "Pages", label: "Home", height: PAGE, view: () => <Page><HomeView /></Page>, skeleton: () => <Page><HomeSkeleton /></Page> },
  { id: "explore-grid", group: "Pages", label: "Explore · grid", query: "view=grid", height: PAGE, view: () => <Page><BoardsView /></Page> },
  { id: "explore-list", group: "Pages", label: "Explore · list", query: "view=list", height: PAGE, view: () => <Page><BoardsView /></Page> },
  { id: "trader", group: "Trader", label: "Trader · desktop (rail, KPI tiles, chart, tabs)", height: 1100, view: ({ address }) => <Page><TraderView address={address} /></Page> },
  { id: "trader-phone", group: "Trader", label: "Trader · phone", width: 390, height: 1000, view: ({ address }) => <Page><TraderView address={address} /></Page>, skeleton: () => <Page><MobileTraderSkeleton /></Page> },
  { id: "trader-tabs", group: "Trader", label: "Trader tabs · positions (before the profile)", height: 520, view: ({ address }) => <Page><TraderView address={address} /></Page>, skeleton: () => <Page><ActivityTabsSkeleton /></Page> },
  { id: "trader-fills", group: "Trader", label: "Trader tab · fills", height: 520, view: () => <Page><FillsLoading /></Page> },
  { id: "trader-trades", group: "Trader", label: "Trader tab · trades", height: 520, view: ({ address }) => <Page><TradesTab address={address} /></Page> },
  { id: "trader-orders", group: "Trader", label: "Trader tab · open orders", height: 520, view: ({ address }) => <Page><OrdersTab address={address} /></Page> },
  { id: "trader-twap", group: "Trader", label: "Trader tab · TWAP", height: 520, view: ({ address }) => <Page><TwapTab address={address} /></Page> },
  { id: "trader-transfers", group: "Trader", label: "Trader tab · transfers", height: 520, view: ({ address }) => <Page><TransfersTab address={address} /></Page> },
  { id: "portfolio", group: "Portfolio", label: "Portfolio", height: PAGE, view: () => <Page><PortfolioView /></Page> },
  { id: "portfolio-copy", group: "Portfolio", label: "Portfolio · copy detail", query: "copy=1", height: PAGE, view: () => <Page><PortfolioView /></Page> },
  { id: "favorites", group: "Favorites", label: "Favorites · saved", height: PAGE, view: () => <Page><FavoritesView /></Page> },
  { id: "favorites-alerts", group: "Favorites", label: "Favorites · alerts", query: "tab=alerts", height: PAGE, view: () => <Page><FavoritesView /></Page> },
  { id: "favorites-feed", group: "Favorites", label: "Favorites · feed", query: "tab=feed", height: PAGE, view: () => <Page><FavoritesView /></Page> },
  { id: "insights", group: "Pages", label: "Insights", height: 1200, view: () => <Page><InsightsView /></Page> },
  { id: "coins", group: "Coins", label: "Coins", height: PAGE, view: () => <Page><CoinIndexView /></Page>, skeleton: () => <Page><CoinIndexSkeleton /></Page> },
  { id: "coin", group: "Coins", label: "Coin detail · BTC", height: PAGE, view: () => <Page><CoinBoardView coin="BTC" /></Page> },
  { id: "settings", group: "Settings & wallet", label: "Settings", height: PAGE, view: () => <Page><SettingsView /></Page> },
  { id: "wallet-deposit", group: "Settings & wallet", label: "Wallet · deposit dialog", height: 760, view: () => <DepositDialog open onOpenChange={noop} /> },
  { id: "wallet-withdraw", group: "Settings & wallet", label: "Wallet · withdraw dialog", height: 760, view: () => <WithdrawDialog open onOpenChange={noop} /> },
  { id: "wallet-history", group: "Settings & wallet", label: "Wallet · funds history", height: 520, view: () => <Page><FundsHistory /></Page> },
  { id: "search", group: "Search", label: "Search dropdown (types “0x”)", height: 560, view: () => <Page><SearchProbe /></Page> },
  { id: "admin", group: "Admin", label: "Admin · overview", height: PAGE, view: () => <Page><AdminShell><AdminOverview /></AdminShell></Page>, skeleton: () => <Page><AdminBodySkeleton /></Page> },
  { id: "admin-users", group: "Admin", label: "Admin · users table", height: PAGE, view: () => <Page><AdminShell><AdminUsers /></AdminShell></Page> },
  { id: "admin-copy", group: "Admin", label: "Admin · copy cards", height: PAGE, view: () => <Page><AdminShell><AdminCopyStatus /></AdminShell></Page> },
];

/** The search box with a query typed, so its dropdown is open. */
function SearchProbe() {
  return (
    <div
      className="max-w-md"
      ref={(node) => {
        const input = node?.querySelector("input");
        if (!input || input.value) return;
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        queueMicrotask(() => {
          input.focus();
          set?.call(input, "0x");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }}
    >
      <AddressSearch />
    </div>
  );
}

export function skeletonItem(id: string): SkeletonItem | undefined {
  return SKELETON_ITEMS.find((item) => item.id === id);
}
