"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { AdminSources } from "@/lib/contracts";
import { api } from "@/lib/api";
import { useI18n } from "@/i18n/provider";
import { Panel, Skeleton, ErrorState } from "@/components/page";
import { Button } from "@/components/ui/button";
export function AdminSourcesView() {
  const { t, format } = useI18n();
  const result = useQuery({
    queryKey: ["admin", "sources"],
    queryFn: ({ signal }) =>
      api.get<AdminSources>("/admin/data-sources", signal),
    refetchInterval: 30_000,
  });
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("sources.title")}</h2>
        <Button
          variant="secondary"
          disabled={result.isFetching}
          onClick={() => result.refetch()}
        >
          {t("jobs.refresh")}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t("sources.hint")}</p>
      <div className="flex flex-wrap gap-4 text-sm">
        <Link className="underline" href="/admin/traders">
          {t("adminTrader.title")}
        </Link>
        <Link className="underline" href="/admin/lists">
          {t("admin.nav.lists")}
        </Link>
        <Link className="underline" href="/admin/system">
          {t("admin.nav.system")}
        </Link>
      </div>
      {result.isError ? (
        <ErrorState
          message={result.error.message}
          onRetry={() => result.refetch()}
        />
      ) : !result.data ? (
        <Skeleton className="h-72" />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {t("adminTrader.sampled")}: {format.dateTime(result.data.sampledAt)}
          </p>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {result.data.items.map((item) => (
              <Panel key={item.id} className="space-y-3 p-5">
                <h3 className="font-semibold">
                  {t(`sources.names.${item.id}`)}
                </h3>
                <p className="text-3xl font-semibold tabular-nums">
                  {item.count}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t(`sources.meanings.${item.id}`)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(`sources.times.${item.id}`)}:{" "}
                  {item.latestAt
                    ? format.dateTime(item.latestAt)
                    : t("adminTrader.missing")}
                </p>
              </Panel>
            ))}
          </div>
        </>
      )}
      <p className="text-xs text-muted-foreground">{t("sources.limit")}</p>
    </div>
  );
}
