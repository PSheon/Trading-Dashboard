"use client";

import { queryKeys } from "@/lib/query-keys";
import { useQuery } from "@tanstack/react-query";
import type { AdminOverview as Overview } from "@/lib/contracts";
import { BellRing, CircleDollarSign, Radar, Users } from "lucide-react";

import { ErrorState, Panel, Skeleton } from "@/components/page";
import { useI18n } from "@/i18n/provider";
import { api } from "@/lib/api";

export function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <Panel className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary-soft text-primary-text">
          <Icon className="size-4" />
        </span>
        {label}
      </div>
      <div className="num text-[1.75rem] leading-none font-bold tracking-tight">{value}</div>
      {sub ? <div className="num text-xs text-subtle-foreground">{sub}</div> : null}
    </Panel>
  );
}

export function AdminOverview() {
  const { t, format } = useI18n();
  const overview = useQuery({
    queryKey: queryKeys.admin.overview,
    queryFn: ({ signal }) => api.get<Overview>("/admin/overview", signal),
    refetchInterval: 60_000,
  });

  if (overview.isError) {
    return (
      <Panel>
        <ErrorState message={overview.error.message} onRetry={() => overview.refetch()} />
      </Panel>
    );
  }
  const d = overview.data;
  if (!d) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[132px] rounded-2xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          icon={Users}
          label={t("admin.overview.users")}
          value={format.num(d.users.total, 0)}
          sub={t("admin.overview.usersSub", { new: d.users.new7d, active: d.users.active7d })}
        />
        <KpiCard
          icon={Radar}
          label={t("admin.overview.traders")}
          value={format.num(d.trackedTraders.total, 0)}
          sub={t("admin.overview.tradersSub", {
            imported: d.trackedTraders.imported,
            favorited: d.trackedTraders.favorited,
          })}
        />
        <KpiCard
          icon={BellRing}
          label={t("admin.overview.alerts")}
          value={
            <>
              {format.num(d.alerts24h.sent, 0)}
              <span className="ml-1.5 text-sm font-medium text-muted-foreground">{t("admin.overview.alertsSent")}</span>
            </>
          }
          sub={t("admin.overview.alertsSub", { failed: d.alerts24h.failed, dryRun: d.alerts24h.dryRun })}
        />
        <KpiCard
          icon={CircleDollarSign}
          label={t("admin.overview.revenue")}
          value={format.usd(d.revenue30dUsd, { digits: 2 })}
          sub={t("admin.overview.revenueSub")}
        />
      </div>
      <p className="num text-right text-[11px] text-subtle-foreground">
        {t("admin.overview.generated", { time: format.dateTime(d.generatedAt) })}
      </p>
    </div>
  );
}
