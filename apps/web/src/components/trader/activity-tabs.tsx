"use client";

import type { TraderFill, TraderProfileResponse } from "@/lib/contracts";
import { useId, useRef, useState } from "react";
import { cn } from "cn";
import { useUrlState } from "@/lib/url-state";

import { useI18n } from "@/i18n/provider";
import { isComputing, isUnavailable, useTraderAnalytics } from "@/lib/queries";
import { Tabs } from "@/components/ui/tabs";
import { SwitchPanel } from "@/components/ui/switch-panel";
import { ActivityFeed } from "./live-feed";
import { MobileInsights } from "./mobile-insights";
import { Loading, PerformanceTab, TradesTab, type PerfView } from "./trade-analytics";
import { POSITION_COLS, PositionsTab } from "./trader-tabs";

/** Phones: the section's box steps aside (display: contents) so the tab
 * row's sticky containing block is the whole page column, not the section
 * it heads; the panel's -mt-4 restores the section's 8px gap inside the
 * column's 24px. */
const PHONE_TABS_SECTION = "max-md:contents";
/** Phones (QA 2026-10-25, 390×844): the summary above pushed the tab row
 * under the fixed 跟單 bar on first view. Sticky to the bottom, the row rests
 * 8px above the bar (clearance = offset + height + 16px) until the page
 * scrolls to its own place; full-bleed page background behind it. */
export const PHONE_TABS_STICKY = "max-md:sticky max-md:bottom-[calc(var(--phone-bar-clearance)-8px+env(safe-area-inset-bottom,0px))] max-md:z-20 max-md:-mx-4 max-md:bg-background max-md:px-4";
/** The panel's least height on every size: an empty or loading tab (暫無持倉)
 * keeps the page's height, so the footer does not jump up on a short page. */
export const TAB_PANEL_MIN = "min-h-48";

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
  phone = false,
}: {
  profile: TraderProfileResponse;
  /** The phone page (MobileTrader): the tab row stays visible above the
   * fixed 跟單 bar (see PHONE_TABS_STICKY). */
  phone?: boolean;
  /** Fills seen on Hyperliquid's WebSocket, merged over the REST list. */
  liveFills?: TraderFill[];
  /** Live mids for the positions' mark column. */
  marks?: Readonly<Record<string, number>>;
}) {
  const { t } = useI18n();
  const panelId = useId();
  // The open tab is in the URL (?tab=), so a shared link opens it.
  const [tab, setUrlTab] = useUrlState<Tab>("tab", TABS, "positions");
  const panelRef = useRef<HTMLDivElement>(null);
  // A tab pressed while the row rests above the 跟單 bar: the page scrolls
  // its panel into view, so the press shows what it opened.
  const setTab = (next: Tab) => {
    setUrlTab(next);
    const panel = panelRef.current;
    if (!phone || !panel) return;
    const top = panel.getBoundingClientRect().top;
    if (top > globalThis.innerHeight * 0.6) globalThis.scrollBy({ top: top - globalThis.innerHeight * 0.4, behavior: "smooth" });
  };
  const [perfView, setPerfView] = useState<PerfView>("best");
  // All-time, like CopyDog's performance tab; shared with the profile rail.
  const analytics = useTraderAnalytics(profile.address, "all");

  return (
    <section className={cn("cd-tables flex flex-col gap-2", phone && PHONE_TABS_SECTION)} data-testid="trader-activity-tabs">
      <Tabs
        value={tab}
        onChange={setTab}
        label={t("trader.tabsLabel")}
        idPrefix={panelId}
        controls={panelId}
        className={cn("py-1", phone && PHONE_TABS_STICKY)}
        items={TABS.map((id) => ({ value: id, label: t(`trader.tabs.${id}`) }))}
      />

      <SwitchPanel ref={panelRef} value={tab} order={TABS} role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${tab}`} tabIndex={0} className={cn(TAB_PANEL_MIN, phone && "-mt-4")}>
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
