"use client";

import { readAlertDisplayValues } from "@/lib/contracts";

import type { ActionFeedItem, TraderFill, TraderProfileResponse } from "@/lib/contracts";
import { Activity, Download } from "lucide-react";
import { Fragment, useId, useMemo, useState } from "react";
import { cn } from "cn";
import { rovingFocus } from "@/lib/roving-focus";

import { ActionsTable, KindBadge } from "@/components/actions/actions-table";
import { LiveBadge } from "@/components/actions/live-badge";
import { EmptyState, ErrorState, SignInPrompt, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import { downloadCsv, toCsv } from "@/lib/csv";
import { coinLabel } from "@/lib/format";
import { mergeLiveFills } from "@/lib/live-trader";
import { isComputing, useAlerts, useLiveActions, useTraderAnalytics, useTraderFills } from "@/lib/queries";
import { PerfSwitch, PerformanceTab, TradesTab, type PerfView } from "./trade-analytics";
import { BalancesTab, FillsTab, OrdersTab, PositionsTab, TransfersTab, TwapTab } from "./trader-tabs";

export type Tab =
  | "positions"
  | "performance"
  | "balances"
  | "orders"
  | "fills"
  | "trades"
  | "twap"
  | "transfers"
  | "actions"
  | "alerts";

/** CopyDog's tab set and order, in groups split by a divider: 持倉 / 表現 |
 * 餘額 / 訂單 / 成交 / 交易 / TWAP / 轉帳, then Orbie's own 動作 / 警報. */
export const TAB_GROUPS: Tab[][] = [
  ["positions", "performance"],
  ["balances", "orders", "fills", "trades", "twap", "transfers"],
  ["actions", "alerts"],
];
const NO_FILLS: TraderFill[] = [];
const NO_MARKS: Readonly<Record<string, number>> = {};

/** The tabs under the chart, CopyDog's set and order, with the live-feed
 * pulse at the right of the bar (it swaps the copy panel for 即時動態).
 * Performance and trades are the round trips the api reconstructs for any
 * address; orders, TWAP and transfers load when their tab opens. Fills and
 * actions export to CSV (競品分析 §3.10: your data, portable). */
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
  const { status } = useAuth();
  const fills = useTraderFills(profile.address, 2000);
  const fillRows = useMemo(() => mergeLiveFills(fills.data, liveFills), [fills.data, liveFills]);
  const {
    query: actions,
    status: actionsStream,
    highlight: newActions,
  } = useLiveActions({ address: profile.address, limit: 200 }, { enabled: tab === "actions" });
  const alerts = useAlerts(profile.address, { enabled: tab === "alerts" && status === "signedIn" });
  // All-time, like CopyDog's performance tab; shared with the profile rail.
  const analytics = useTraderAnalytics(profile.address, "all");

  const exportable = tab === "fills" ? fillRows : tab === "actions" ? actions.data : undefined;

  return (
    <section className="rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3">
        <div role="tablist" aria-label={t("trader.tabsLabel")} className="flex min-w-0 items-center overflow-x-auto no-scrollbar">
          {TAB_GROUPS.map((group, g) => (
            <Fragment key={g}>
              {g > 0 ? <span aria-hidden className="mx-1.5 h-3.5 w-px shrink-0 bg-border-strong" /> : null}
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
                    "relative shrink-0 px-2.5 py-3.5 text-[0.8125rem] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    tab === id ? "text-foreground" : "text-subtle-foreground hover:text-muted-foreground",
                  )}
                >
                  {t(`trader.tabs.${id}`)}
                  {tab === id ? <span className="absolute inset-x-2.5 bottom-0 h-0.5 rounded-full bg-primary" /> : null}
                </button>
              ))}
            </Fragment>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {tab === "actions" ? <LiveBadge status={actionsStream} /> : null}
          {tab === "performance" ? <PerfSwitch value={perfView} onChange={setPerfView} /> : null}
          {exportable && exportable.length > 0 ? (
            <Button
              variant="ghost"
              aria-label={t("common.exportCsv")}
              size="sm"
              onClick={() =>
                tab === "fills"
                  ? exportFills(profile.address, fillRows ?? [])
                  : exportActions(profile.address, actions.data ?? [])
              }
            >
              <Download />
              <span className="hidden xl:inline">{t("common.exportCsv")}</span>
            </Button>
          ) : null}
          {onToggleFeed ? (
            <button
              type="button"
              onClick={onToggleFeed}
              aria-pressed={feedOpen}
              aria-label={feedOpen ? t("trader.activity.hide") : t("trader.activity.pulse")}
              title={feedOpen ? t("trader.activity.hide") : t("trader.activity.pulse")}
              className={cn(
                "hidden size-8 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring lg:inline-flex",
                feedOpen ? "bg-primary-soft text-primary" : "text-muted-foreground hover:bg-raised hover:text-foreground",
              )}
            >
              <Activity className="size-4" />
            </button>
          ) : null}
        </div>
      </div>

      <div role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${tab}`} tabIndex={0} className="min-h-[180px]">
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
            <FillsTab rows={fillRows} />
          )
        ) : null}
        {tab === "trades" ? <TradesTab address={profile.address} /> : null}
        {tab === "twap" ? <TwapTab address={profile.address} /> : null}
        {tab === "transfers" ? <TransfersTab address={profile.address} /> : null}
        {tab === "actions" ? (
          actions.isError ? (
            <ErrorState message={actions.error.message} onRetry={() => actions.refetch()} />
          ) : !actions.data ? (
            <Loading />
          ) : actions.data.length === 0 ? (
            <EmptyState title={t("trader.noActions")} />
          ) : (
            <ActionsTable rows={actions.data} showTrader={false} highlight={newActions} />
          )
        ) : null}
        {tab === "alerts" ? (
          status !== "signedIn" ? (
            <SignInPrompt title={t("trader.alertsSignIn")} />
          ) : alerts.isError ? (
            <ErrorState message={alerts.error.message} onRetry={() => alerts.refetch()} />
          ) : !alerts.data ? (
            <Loading />
          ) : alerts.data.length === 0 ? (
            <EmptyState title={t("trader.noAlerts")} />
          ) : (
            <AlertsList rows={alerts.data} />
          )
        ) : null}
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

function AlertsList({ rows }: { rows: NonNullable<ReturnType<typeof useAlerts>["data"]> }) {
  const { t, format } = useI18n();
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("trader.cols.time")}</TableHead>
          <TableHead>{t("trader.cols.coin")}</TableHead>
          <TableHead>{t("actions.cols.action")}</TableHead>
          <TableHead className="text-right">{t("actions.cols.notional")}</TableHead>
          <TableHead className="text-right">{t("trader.cols.status")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((a) => {
          const values = readAlertDisplayValues(a.payloadJson);
          const kind = values?.actionKind;
          return (
            <TableRow key={String(a.id)}>
              <TableCell className="num font-mono text-xs text-muted-foreground">{format.dateTime(a.sentAt)}</TableCell>
              <TableCell className="font-semibold">{a.coin ? coinLabel(a.coin) : "—"}</TableCell>
              <TableCell>{kind ? <KindBadge kind={kind} /> : "—"}</TableCell>
              <TableCell className="text-right">
                {format.usd(values?.notionalUsd, { compact: true })}
              </TableCell>
              <TableCell className="text-right">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    a.sendStatus === "failed"
                      ? "bg-negative-soft text-negative"
                      : a.sendStatus === "sent"
                        ? "bg-positive-soft text-positive"
                        : "bg-raised text-muted-foreground",
                  )}
                >
                  {a.sendStatus}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function exportFills(address: string, rows: TraderFill[]) {
  downloadCsv(
    `${address}-fills.csv`,
    toCsv(
      ["time_utc", "tid", "coin", "side", "dir", "px", "sz", "notional_usd", "fee", "closed_pnl", "start_position", "liquidation", "twap_id"],
      rows.map((f) => [
        new Date(f.ts).toISOString(),
        f.tid,
        f.coin,
        f.side,
        f.dir,
        f.px,
        f.sz,
        f.notionalUsd,
        f.fee,
        f.closedPnl,
        f.startPosition ?? null,
        f.liquidation ? "true" : "false",
        f.twapId ?? null,
      ]),
    ),
  );
}

function exportActions(address: string, rows: ActionFeedItem[]) {
  downloadCsv(
    `${address}-actions.csv`,
    toCsv(
      ["time_utc", "id", "coin", "kind", "side", "notional_usd", "avg_px", "leverage", "fills"],
      rows.map((a) => [
        new Date(a.ts).toISOString(),
        String(a.id),
        a.coin,
        a.kind,
        a.side,
        String(a.notionalUsd),
        String(a.avgPx),
        a.leverage === null || a.leverage === undefined ? "" : String(a.leverage),
        a.fillIds.length,
      ]),
    ),
  );
}
