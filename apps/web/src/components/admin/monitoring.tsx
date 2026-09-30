"use client";

import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { WorkerHeartbeat } from "./worker-heartbeat";
import type { HeartbeatResponse } from "@/lib/contracts";
import type { AdminSystemOverview } from "@/lib/contracts";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { Panel, Skeleton } from "@/components/page";
import { useI18n } from "@/i18n/provider";

export function AdminMonitoring() {
  const { t, format } = useI18n();
  const query = useQuery({ queryKey: queryKeys.adminSystem, queryFn: ({ signal }) => api.get<AdminSystemOverview>("/admin/system/overview", signal), refetchInterval: 15_000 });
  // Combined development mode has no independent worker. Its existing local
  // heartbeat remains available, while split deployments use one coherent sample.
  const local = useQuery({ queryKey: queryKeys.health, queryFn: ({signal}) => api.get<HeartbeatResponse>("/health", signal), enabled: query.data?.api.role === "combined", refetchInterval: 15_000 });
  const heartbeat = query.data?.api.role === "combined" ? local.data : query.data?.worker.sample?.heartbeat;
  return <section className="space-y-4" aria-labelledby="monitoring-title" aria-busy={query.isFetching}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 id="monitoring-title" className="text-lg font-bold">{t("monitoring.title")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("monitoring.hint")}</p>
        {query.data && <p className="mt-2 text-xs text-muted-foreground">{t("monitoring.sample")} · {format.dateTime(query.data.sampledAt)}</p>}
      </div>
      <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching} className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-raised disabled:opacity-50">{t("monitoring.refresh")}</button>
    </div>
    {query.isError && <p role="alert" className="rounded-lg bg-warning/10 p-3 text-sm text-warning">{t(query.data ? "monitoring.cached" : "monitoring.unavailable")}</p>}
    {query.data ? <MonitoringDetails data={query.data} /> : !query.isError && <Skeleton className="h-72" />}
    {heartbeat && <WorkerHeartbeat data={heartbeat} />}
  </section>;
}

export function MonitoringDetails({ data: d }: { data: AdminSystemOverview }) {
  const { t, format } = useI18n();
  const time = (v: string | null) => v ? format.dateTime(v) : t("monitoring.never");
  const worker = d.worker.sample;
  const budget = (v: AdminSystemOverview["api"]["budget"] | null) => <>
    <p className="mt-4 text-xs font-semibold text-muted-foreground">{t("monitoring.budget")}</p>
    <dl className="mt-1 divide-y divide-border text-xs">
      <Metric label={t("monitoring.consumed")} value={v?.weightLastMinute ?? t("monitoring.unknown")} />
      <Metric label={t("monitoring.effective")} value={v ? `${v.effectiveBudgetPerMin} / ${v.configuredBudgetPerMin}` : t("monitoring.unknown")} />
      <Metric label={t("monitoring.queued")} value={v ? `${v.queued.live} / ${v.queued.background}` : t("monitoring.unknown")} />
      <Metric label={t("monitoring.last429")} value={v ? time(v.lastRateLimitedAt) : t("monitoring.unknown")} />
    </dl>
  </>;
  return <div className="space-y-4">
    <div className="grid gap-4 lg:grid-cols-3">
      <Panel className="p-5"><h3 className="font-semibold">API · {d.api.role}</h3><Status state={d.api.state} />
        <p className="mt-3 text-xs text-muted-foreground">{t("monitoring.uptime")} · {t("monitoring.seconds", {value: format.num(d.api.uptimeSeconds, 0)})}</p>{budget(d.api.budget)}</Panel>
      <Panel className="p-5"><h3 className="font-semibold">Worker</h3><Status state={d.worker.state} />
        {worker && <p className="mt-3 text-xs text-muted-foreground">{t("monitoring.sample")} · {time(worker.sampledAt)}</p>}{budget(worker?.budget ?? null)}</Panel>
      <Panel className="p-5"><h3 className="font-semibold">PostgreSQL</h3><Status state={d.database.state} />
        <dl className="mt-3 text-xs"><Metric label={t("monitoring.latency")} value={d.database.latencyMs === null ? t("monitoring.unknown") : t("monitoring.milliseconds", {value: d.database.latencyMs})} /></dl></Panel>
    </div>
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Panel className="p-5"><h3 className="font-semibold">{t("monitoring.data")}</h3>
        {!d.data ? <p className="mt-4 text-sm text-muted-foreground">{t("monitoring.dataMissing")}</p> : <dl className="mt-3 divide-y divide-border text-sm">
          <Metric label={t("monitoring.leaderboard")} value={format.num(d.data.leaderboardCount, 0)} />
          <Metric label={t("monitoring.leaderboardAt")} value={time(d.data.leaderboardUpdatedAt)} />
          <Metric label={t("monitoring.watched")} value={d.data.watched} />
          <Metric label={t("monitoring.portfolios")} value={`${d.data.portfolios} / ${d.data.candidates}`} />
          <Metric label={t("monitoring.trades")} value={`${d.data.trades} / ${d.data.candidates}`} />
          <Metric label={t("monitoring.errors")} value={d.data.errors} />
          <Metric label={t("monitoring.oldest")} value={time(d.data.oldestPortfolioAt)} />
          <Metric label={t("monitoring.newest")} value={time(d.data.newestPortfolioAt)} />
        </dl>}<p className="mt-3 text-xs leading-relaxed text-muted-foreground">{t("monitoring.coverageHint")}</p>
      </Panel>
      <Panel className="p-5"><h3 className="font-semibold">{t("monitoring.outbox")}</h3>
        {d.outbox === null ? <p className="mt-4 text-sm text-muted-foreground">{t("monitoring.outboxMissing")}</p> : d.outbox.map(q => <div key={q.kind} className="mt-4">
          <h4 className="text-sm font-medium">{t(`monitoring.${q.kind}`)}</h4>
          <dl className="mt-1 divide-y divide-border text-xs">
            {(["pending", "processing", "failed", "due"] as const).map(key => <Metric key={key} label={t(`monitoring.${key}`)} value={q[key]} />)}
            <Metric label={t("monitoring.expired")} value={q.expiredLeases} />
            <Metric label={t("monitoring.oldestDue")} value={time(q.oldestDueAt)} />
          </dl></div>)}<p className="mt-3 text-xs leading-relaxed text-muted-foreground">{t("monitoring.queueHint")}</p>
      </Panel>
    </div>
  </div>;
}
function Status({ state }: {state: AdminSystemOverview["worker"]["state"] | "available"}) {
  const { t } = useI18n();
  return <span className={cn("mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold", state === "active" || state === "available" ? "bg-positive-soft text-positive" : "bg-warning/10 text-warning")}>{t(`monitoring.${state}`)}</span>;
}
function Metric({label, value}: {label: string; value: React.ReactNode}) {
  return <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2"><dt className="text-muted-foreground">{label}</dt><dd className="num break-words text-right">{value}</dd></div>;
}
