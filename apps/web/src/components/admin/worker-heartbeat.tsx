"use client";

import type { HeartbeatResponse } from "@/lib/contracts";
import { cn } from "cn";

import { Panel } from "@/components/page";
import { useI18n } from "@/i18n/provider";
import { truncateAddress } from "@/lib/format";

/** Feed details from the same worker sample as the service status. */
export function WorkerHeartbeat({ data: d }: { data: HeartbeatResponse }) {
  const { t, format } = useI18n();
  const time = (v: Date | string | null) => (v ? `${format.relative(v)} · ${format.time(v)}` : t("common.never"));

  return (
    <Panel className="card-pad">
      <h2 className="type-h2">{t("admin.statusTitle")}</h2>
      <p className="mt-1 text-[0.8125rem] text-muted-foreground">{t("monitoring.feedHint")}</p>
      <div className="mt-5">
          <dl className="num divide-y-2 divide-dotted divide-border text-[0.8125rem]">
            <Row label={t("admin.status.feed")}>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
                  d.feedConnected ? "bg-tag-profit text-tag-profit-foreground" : "bg-tag-loss text-tag-loss-foreground",
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
                  d.dryRun ? "bg-tag-warning text-tag-warning-foreground" : "bg-raised text-muted-foreground",
                )}
              >
                {d.dryRun ? t("admin.status.dryRunOn") : t("admin.status.dryRunOff")}
              </span>
            </Row>
          </dl>
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
