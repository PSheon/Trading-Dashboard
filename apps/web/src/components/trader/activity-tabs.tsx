"use client";

import type { TraderFill, TraderProfileResponse } from "@/lib/contracts";
import { useId, useState } from "react";
import { useUrlState } from "@/lib/url-state";

import { useI18n } from "@/i18n/provider";
import { isComputing, isUnavailable, useTraderAnalytics } from "@/lib/queries";
import { Tabs } from "@/components/ui/tabs";
import { SwitchPanel } from "@/components/ui/switch-panel";
import { ActivityFeed } from "./live-feed";
import { MobileInsights } from "./mobile-insights";
import { Loading, PerformanceTab, TradesTab, type PerfView } from "./trade-analytics";
import { POSITION_COLS, PositionsTab } from "./trader-tabs";

export type Tab = "positions" | "insights" | "performance" | "trades" | "activity";

/** The trader page's tabs, the same five on desktop and phones (Paul,
 * 2026-10-07): 持倉 / 洞察 / 表現 / 交易 / 動態. 動態 is the recent fills and
 * transfers that sat behind a pulse in the tab bar and took the copy
 * panel's place; the copy panel now always stays. */
export const TABS: readonly Tab[] = ["positions", "insights", "performance", "trades", "activity"];
const NO_FILLS: TraderFill[] = [];
const NO_MARKS: Readonly<Record<string, number>> = {};

/** The tabs under the chart (desktop) or the figures (phones): one tab row,
 * one panel, every table or list ten rows a page with the same pager.
 * Performance and trades are the round trips the api reconstructs for any
 * address; 動態 reads the fills and transfers when its tab opens. */
export function ActivityTabs({
  profile,
  liveFills = NO_FILLS,
  marks = NO_MARKS,
}: {
  profile: TraderProfileResponse;
  /** Fills seen on Hyperliquid's WebSocket, merged over the REST list. */
  liveFills?: TraderFill[];
  /** Live mids for the positions' mark column. */
  marks?: Readonly<Record<string, number>>;
}) {
  const { t } = useI18n();
  const panelId = useId();
  // The open tab is in the URL (?tab=), so a shared link opens it.
  const [tab, setTab] = useUrlState<Tab>("tab", TABS, "positions");
  const [perfView, setPerfView] = useState<PerfView>("best");
  // All-time, like CopyDog's performance tab; shared with the profile rail.
  const analytics = useTraderAnalytics(profile.address, "all");

  return (
    <section className="cd-tables flex flex-col gap-2">
      <Tabs
        value={tab}
        onChange={setTab}
        label={t("trader.tabsLabel")}
        idPrefix={panelId}
        controls={panelId}
        className="py-1"
        items={TABS.map((id) => ({ value: id, label: t(`trader.tabs.${id}`) }))}
      />

      <SwitchPanel value={tab} order={TABS} role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${tab}`} tabIndex={0}>
        {tab === "positions" ? <PositionsTab profile={profile} marks={marks} /> : null}
        {tab === "insights" ? <MobileInsights profile={profile} trades={analytics.data} computing={isComputing(analytics)} /> : null}
        {tab === "performance" ? (
          <PerformanceTab
            analytics={analytics.data}
            computing={isComputing(analytics)}
            unavailable={isUnavailable(analytics)}
            error={analytics.error}
            onRetry={() => analytics.refetch()}
            view={perfView}
            onView={setPerfView}
          />
        ) : null}
        {tab === "trades" ? <TradesTab address={profile.address} /> : null}
        {tab === "activity" ? <ActivityFeed address={profile.address} liveFills={liveFills} /> : null}
      </SwitchPanel>
    </section>
  );
}

/** The tabs before the profile is in: the same row (持倉 lit) over the
 * positions table's header and rows of bars. */
export function ActivityTabsSkeleton() {
  const { t } = useI18n();
  return (
    <section className="cd-tables flex flex-col gap-2" aria-hidden="true">
      <div className="flex min-w-0 items-center gap-1 overflow-hidden py-1">
        {TABS.map((id) => (
          <span
            key={id}
            className={
              id === "positions"
                ? "flex h-11 shrink-0 items-center rounded-full bg-primary px-4 text-[15px] font-extrabold whitespace-nowrap text-primary-foreground"
                : "flex h-11 shrink-0 items-center rounded-full px-4 text-[15px] font-bold whitespace-nowrap text-muted-foreground"
            }
          >
            {t(`trader.tabs.${id}`)}
          </span>
        ))}
      </div>
      <Loading cols={POSITION_COLS.map((k) => t(`trader.cols.${k}`))} />
    </section>
  );
}
