"use client";

import type { TraderFill, TraderProfileResponse } from "@/lib/contracts";
import { Activity } from "lucide-react";
import { Fragment, useId, useMemo, useState } from "react";
import { cn } from "cn";
import { rovingFocus } from "@/lib/roving-focus";

import { ErrorState, Skeleton } from "@/components/page";
import { useI18n } from "@/i18n/provider";
import { mergeLiveFills } from "@/lib/live-trader";
import { isComputing, useTraderAnalytics, useTraderFills } from "@/lib/queries";
import { PerfSwitch, PerformanceTab, TradesTab, type PerfView } from "./trade-analytics";
import { BalancesTab, FILL_LIMIT, FillsTab, fillsTruncated, OrdersTab, PositionsTab, TransfersTab, TwapTab } from "./trader-tabs";

export type Tab =
  | "positions"
  | "performance"
  | "balances"
  | "orders"
  | "fills"
  | "trades"
  | "twap"
  | "transfers";

/** CopyDog's tab set and order, in groups split by a divider: 持倉 / 表現 |
 * 餘額 / 訂單 / 成交 / 交易 / TWAP / 轉帳. Alert settings sit behind the
 * bell next to the trader's name and the live feed behind the pulse, as on
 * CopyDog. */
export const TAB_GROUPS: Tab[][] = [
  ["positions", "performance"],
  ["balances", "orders", "fills", "trades", "twap", "transfers"],
];
const NO_FILLS: TraderFill[] = [];
const NO_MARKS: Readonly<Record<string, number>> = {};

/** The tabs under the chart, CopyDog's set and order, with the live-feed
 * pulse at the right of the bar (it swaps the copy panel for 即時動態).
 * Performance and trades are the round trips the api reconstructs for any
 * address; orders, TWAP and transfers load when their tab opens. (Fills
 * export to CSV lives on /dev: CopyDog has no export.) */
export function ActivityTabs({
  profile,
  liveFills = NO_FILLS,
  marks = NO_MARKS,
  feedOpen = false,
  onToggleFeed,
}: {
  profile: TraderProfileResponse;
  /** Fills seen on Hyperliquid's WebSocket, merged over the REST list. */
  liveFills?: TraderFill[];
  /** Live mids for the positions' mark column. */
  marks?: Readonly<Record<string, number>>;
  /** The live feed is shown in the copy panel's place. */
  feedOpen?: boolean;
  onToggleFeed?: () => void;
}) {
  const { t } = useI18n();
  const panelId = useId();
  const [tab, setTab] = useState<Tab>("positions");
  const [perfView, setPerfView] = useState<PerfView>("best");
  const fills = useTraderFills(profile.address, FILL_LIMIT);
  const fillRows = useMemo(() => mergeLiveFills(fills.data, liveFills), [fills.data, liveFills]);
  // All-time, like CopyDog's performance tab; shared with the profile rail.
  const analytics = useTraderAnalytics(profile.address, "all");

  return (
    <section className="cd-tables overflow-hidden rounded-[12px] border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3">
        <div role="tablist" aria-label={t("trader.tabsLabel")} className="flex min-w-0 items-center overflow-x-auto no-scrollbar">
          {TAB_GROUPS.map((group, g) => (
            <Fragment key={g}>
              {g > 0 ? <span aria-hidden className="mr-4 h-3.5 w-px shrink-0 bg-border-strong" /> : null}
              {group.map((id) => (
                <button
                  key={id}
                  role="tab"
                  type="button"
                  id={`${panelId}-${id}`}
                  aria-controls={panelId}
                  tabIndex={tab === id ? 0 : -1}
                  onKeyDown={rovingFocus}
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className={cn(
                    "mr-[22px] shrink-0 border-b-2 px-0.5 py-3 font-mono text-xs leading-[18px] font-semibold tracking-[0.4px] whitespace-nowrap uppercase outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    tab === id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`trader.tabs.${id}`)}
                </button>
              ))}
            </Fragment>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {tab === "performance" ? <PerfSwitch value={perfView} onChange={setPerfView} /> : null}
          {onToggleFeed ? (
            <button
              type="button"
              onClick={onToggleFeed}
              aria-pressed={feedOpen}
              aria-label={feedOpen ? t("trader.activity.hide") : t("trader.activity.pulse")}
              title={feedOpen ? t("trader.activity.hide") : t("trader.activity.pulse")}
              className={cn(
                "hidden size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring lg:inline-flex",
                feedOpen ? "text-primary" : "text-muted-foreground hover:bg-raised hover:text-foreground",
              )}
            >
              <Activity className="size-4" />
            </button>
          ) : null}
        </div>
      </div>

      <div role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${tab}`} tabIndex={0}>
        {tab === "positions" ? <PositionsTab profile={profile} marks={marks} /> : null}
        {tab === "performance" ? (
          <PerformanceTab
            analytics={analytics.data}
            computing={isComputing(analytics)}
            error={analytics.error}
            onRetry={() => analytics.refetch()}
            view={perfView}
            onView={setPerfView}
          />
        ) : null}
        {tab === "balances" ? <BalancesTab balances={profile.spotBalances} /> : null}
        {tab === "orders" ? <OrdersTab address={profile.address} /> : null}
        {tab === "fills" ? (
          fills.isError ? (
            <ErrorState message={fills.error.message} onRetry={() => fills.refetch()} />
          ) : !fillRows ? (
            <Loading />
          ) : (
            <FillsTab rows={fillRows} truncated={fillsTruncated(fills.data)} />
          )
        ) : null}
        {tab === "trades" ? <TradesTab address={profile.address} /> : null}
        {tab === "twap" ? <TwapTab address={profile.address} /> : null}
        {tab === "transfers" ? <TransfersTab address={profile.address} /> : null}
      </div>
    </section>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-2 p-5">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-9" />
      ))}
    </div>
  );
}
