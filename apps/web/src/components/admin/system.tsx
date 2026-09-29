"use client";

import { useQuery } from "@tanstack/react-query";
import type { HeartbeatResponse } from "@trading-dashboard/shared";
import { cn } from "cn";

import { Panel, Skeleton } from "@/components/page";
import { useI18n } from "@/i18n/provider";
import { api } from "@/lib/api";
import { truncateAddress } from "@/lib/format";

/** System status from GET /health (§8 heartbeat). */
export function AdminSystem() {
  const { t, format } = useI18n();
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<HeartbeatResponse>("/health"),
  });
  const time = (v: Date | string | null) => (v ? `${format.relative(v)} · ${format.time(v)}` : t("common.never"));

  const d = health.data;
  return (
    <Panel className="max-w-3xl p-5 md:p-6">
      <h2 className="text-base font-bold tracking-tight">{t("admin.statusTitle")}</h2>
      <p className="mt-1 text-[0.8125rem] text-muted-foreground">{t("admin.statusHint")}</p>
      <div className="mt-5">
        {health.isError ? (
          <p className="text-sm text-negative">{t("admin.status.unreachable", { message: health.error.message })}</p>
        ) : !d ? (
          <Skeleton className="h-64" />
        ) : (
          <dl className="num divide-y divide-border text-[0.8125rem]">
            <Row label={t("admin.status.feed")}>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
                  d.feedConnected ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative",
                )}
              >
                <span className={cn("size-1.5 rounded-full", d.feedConnected ? "bg-positive" : "bg-negative")} />
                {d.feedConnected
                  ? t("admin.status.connected", { markets: d.marketsSubscribed })
                  : d.feedDisconnectedSince
                    ? t("admin.status.downSince", {
                        time: format.dateTime(d.feedDisconnectedSince),
                        open: d.feedSocketsOpen,
                        total: d.feedSocketsTotal,
                      })
                    : t("admin.status.down", { open: d.feedSocketsOpen, total: d.feedSocketsTotal })}
              </span>
            </Row>
            <Row label={t("admin.status.lastTrade")}>{time(d.lastTradeAt)}</Row>
            <Row label={t("admin.status.lastFill")}>{time(d.lastFillAt)}</Row>
            <Row label={t("admin.status.lastSnapshot")}>{time(d.lastSnapshotAt)}</Row>
            <Row label={t("admin.status.lastSweep")}>{time(d.lastSweepAt)}</Row>
            <Row label={t("admin.status.rest")}>
              {t("admin.status.restValue", {
                requests: d.requestsLastMinute,
                weight: format.num(d.weightLastMinute, 0),
                live: d.queuedRequests.live,
                background: d.queuedRequests.background,
              })}
            </Row>
            <Row label={t("admin.status.fillsMissing")}>
              {d.fillsUnavailable.length === 0 ? (
                t("admin.status.none")
              ) : (
                <span className="flex flex-col items-end gap-1">
                  {d.fillsUnavailable.map((f) => (
                    <span key={f.address} className="font-mono text-xs">
                      {t("admin.status.fillsMissingValue", {
                        address: truncateAddress(f.address),
                        count: f.missedTrades,
                        time: format.dateTime(f.since),
                      })}
                    </span>
                  ))}
                </span>
              )}
            </Row>
            <Row label={t("admin.status.dryRun")}>
              <span
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-semibold",
                  d.dryRun ? "bg-warning/15 text-warning" : "bg-raised text-muted-foreground",
                )}
              >
                {d.dryRun ? t("admin.status.dryRunOn") : t("admin.status.dryRunOff")}
              </span>
            </Row>
          </dl>
        )}
      </div>
    </Panel>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
