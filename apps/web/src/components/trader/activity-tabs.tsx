"use client";

import { readAlertDisplayValues } from "@/lib/contracts";

import type { ActionFeedItem, TraderFill, TraderProfileResponse } from "@/lib/contracts";
import { Download } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";

import { ActionsTable, KindBadge, SideText } from "@/components/actions/actions-table";
import { LiveBadge } from "@/components/actions/live-badge";
import { EmptyState, ErrorState, SignInPrompt, Skeleton } from "@/components/page";
import { CoinIcon } from "@/components/traders/coin-icon";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { useAuth } from "@/lib/auth";
import { downloadCsv, toCsv } from "@/lib/csv";
import { coinLabel } from "@/lib/format";
import { useAlerts, useLiveActions, useTraderFills } from "@/lib/queries";

type Tab = "positions" | "fills" | "actions" | "alerts";
const TABS: Tab[] = ["positions", "fills", "actions", "alerts"];

/** Positions / fills / actions / alerts under the chart. Fills and actions
 * export to CSV (競品分析 §3.10: your data, portable). */
export function ActivityTabs({ profile }: { profile: TraderProfileResponse }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("positions");
  const { status } = useAuth();
  const fills = useTraderFills(profile.address, 200);
  const {
    query: actions,
    status: actionsStream,
    highlight: newActions,
  } = useLiveActions({ address: profile.address, limit: 200 }, { enabled: tab === "actions" });
  const alerts = useAlerts(profile.address, { enabled: tab === "alerts" && status === "signedIn" });

  const exportable = tab === "fills" ? fills.data : tab === "actions" ? actions.data : undefined;

  return (
    <section className="rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3">
        <div role="tablist" className="flex overflow-x-auto no-scrollbar">
          {TABS.map((id) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "relative shrink-0 px-3 py-3.5 text-[0.8125rem] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tab === id ? "text-foreground" : "text-subtle-foreground hover:text-muted-foreground",
              )}
            >
              {t(`trader.tabs.${id}`)}
              {id === "positions" && profile.positions.length > 0 ? (
                <span className="num ml-1.5 rounded-full bg-raised px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {profile.positions.length}
                </span>
              ) : null}
              {tab === id ? <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary" /> : null}
            </button>
          ))}
        </div>
        {tab === "actions" ? <LiveBadge status={actionsStream} className="ml-auto" /> : null}
        {exportable && exportable.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              tab === "fills"
                ? exportFills(profile.address, fills.data ?? [])
                : exportActions(profile.address, actions.data ?? [])
            }
          >
            <Download />
            <span className="hidden sm:inline">{t("common.exportCsv")}</span>
          </Button>
        ) : null}
      </div>

      <div role="tabpanel" className="min-h-[180px]">
        {tab === "positions" ? <Positions profile={profile} /> : null}
        {tab === "fills" ? (
          fills.isError ? (
            <ErrorState message={fills.error.message} onRetry={() => fills.refetch()} />
          ) : !fills.data ? (
            <Loading />
          ) : fills.data.length === 0 ? (
            <EmptyState title={t("trader.noFills")} />
          ) : (
            <Fills rows={fills.data} />
          )
        ) : null}
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

function Positions({ profile }: { profile: TraderProfileResponse }) {
  const { t, format } = useI18n();
  if (profile.positions.length === 0) return <EmptyState title={t("trader.noPositions")} />;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("trader.cols.coin")}</TableHead>
          <TableHead>{t("trader.cols.side")}</TableHead>
          <TableHead className="text-right">{t("trader.cols.value")}</TableHead>
          <TableHead className="hidden text-right sm:table-cell">{t("trader.cols.size")}</TableHead>
          <TableHead className="hidden text-right md:table-cell">{t("trader.cols.entry")}</TableHead>
          <TableHead className="text-right">{t("trader.cols.pnl")}</TableHead>
          <TableHead className="hidden text-right lg:table-cell">{t("trader.cols.liq")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {profile.positions.map((p) => (
          <TableRow key={p.coin}>
            <TableCell>
              <span className="flex items-center gap-2 font-semibold">
                <CoinIcon coin={p.coin} size={20} />
                {coinLabel(p.coin)}
                {p.leverage ? (
                  <span className="rounded-md bg-raised px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    {format.num(p.leverage, 0)}× {p.marginMode === "isolated" ? t("trader.cols.isolated") : ""}
                  </span>
                ) : null}
              </span>
            </TableCell>
            <TableCell>
              <SideText side={p.side} />
            </TableCell>
            <TableCell className="text-right font-semibold">{format.usd(p.positionValue, { compact: true })}</TableCell>
            <TableCell className="hidden text-right text-muted-foreground sm:table-cell">
              {format.num(Math.abs(p.szi), 4)}
            </TableCell>
            <TableCell className="hidden text-right text-muted-foreground md:table-cell">{format.price(p.entryPx)}</TableCell>
            <TableCell
              className={cn("text-right font-semibold", p.unrealizedPnl >= 0 ? "text-positive" : "text-negative")}
            >
              {format.usd(p.unrealizedPnl, { sign: true, compact: Math.abs(p.unrealizedPnl) >= 1e5 })}
            </TableCell>
            <TableCell className="hidden text-right text-muted-foreground lg:table-cell">{format.price(p.liqPx)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Fills({ rows }: { rows: TraderFill[] }) {
  const { t, format } = useI18n();
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("trader.cols.time")}</TableHead>
          <TableHead>{t("trader.cols.coin")}</TableHead>
          <TableHead>{t("trader.cols.dir")}</TableHead>
          <TableHead className="text-right">{t("trader.cols.price")}</TableHead>
          <TableHead className="hidden text-right sm:table-cell">{t("trader.cols.size")}</TableHead>
          <TableHead className="text-right">{t("trader.cols.notional")}</TableHead>
          <TableHead className="hidden text-right md:table-cell">{t("trader.cols.fee")}</TableHead>
          <TableHead className="text-right">{t("trader.cols.closedPnl")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((f) => (
          <TableRow key={f.tid}>
            <TableCell className="text-muted-foreground">{format.dateTime(f.ts)}</TableCell>
            <TableCell>
              <span className="flex items-center gap-2 font-semibold">
                <CoinIcon coin={f.coin} size={18} />
                {coinLabel(f.coin)}
                {f.twapId != null ? (
                  <span
                    title={t("trader.twapHint", { id: f.twapId })}
                    className="rounded bg-raised px-1 py-px text-[0.625rem] font-semibold tracking-wide text-muted-foreground"
                  >
                    {t("trader.twap")}
                  </span>
                ) : null}
              </span>
            </TableCell>
            <TableCell className={f.side === "buy" ? "text-positive" : "text-negative"}>{f.dir}</TableCell>
            <TableCell className="text-right">{format.price(f.px)}</TableCell>
            <TableCell className="hidden text-right text-muted-foreground sm:table-cell">{format.num(f.sz, 4)}</TableCell>
            <TableCell className="text-right">{format.usd(f.notionalUsd, { compact: true })}</TableCell>
            <TableCell className="hidden text-right text-muted-foreground md:table-cell">{format.usd(f.fee)}</TableCell>
            <TableCell
              className={cn(
                "text-right font-semibold",
                f.closedPnl ? (f.closedPnl > 0 ? "text-positive" : "text-negative") : "text-subtle-foreground",
              )}
            >
              {f.closedPnl ? format.usd(f.closedPnl, { sign: true }) : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
              <TableCell className="text-muted-foreground">{format.dateTime(a.sentAt)}</TableCell>
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
      ["time_utc", "tid", "coin", "side", "dir", "px", "sz", "notional_usd", "fee", "closed_pnl", "twap_id"],
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
