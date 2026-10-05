"use client";

import Link from "next/link";
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown, Settings } from "lucide-react";
import { cn } from "cn";

import { ErrorState, SkelBar } from "@/components/page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/i18n/provider";
import { useAdminCopyOverview } from "@/lib/admin-copy";
import { api } from "@/lib/api";
import { usePermission } from "@/lib/auth";
import type { AdminOverview as Overview, AdminRevenueResponse, AdminSources, AdminSystemOverview, BackfillJobsResponse, SettingsRuntime } from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";
import { MonitoringDetails } from "./monitoring";
import { archiveState, OperationalSwitchesPanel } from "./operational-switches";
import { AdminCard, Fact, Facts, StatTile } from "./ui";
import { WorkerHeartbeat } from "./worker-heartbeat";

type Range = "7d" | "30d" | "90d" | "all";
const RANGES: Range[] = ["7d", "30d", "90d", "all"];

/**
 * 總覽 (C-AdminNew-Overview): the KPI row, revenue (the old 收入 page),
 * service status, data freshness and queues (the old 系統 page), the
 * deployment's read-only switches and tuning, and the collection counts
 * (the old 資料來源 page). Each block asks only what its permission allows.
 */
export function AdminOverview() {
  const canSystem = usePermission("admin.access");
  const canRevenue = usePermission("revenue.read");
  const canSources = usePermission("sources.read");
  const system = useQuery({ queryKey: queryKeys.adminSystem, queryFn: ({ signal }) => api.get<AdminSystemOverview>("/admin/system/overview", signal), refetchInterval: 15_000, enabled: canSystem });
  return (
    <div className="flex flex-col gap-4">
      <Kpis />
      {canRevenue ? <RevenueCard /> : null}
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <ServiceCard system={system} />
        <FreshnessCard system={system.data} />
        <QueuesCard system={system.data} />
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <DeployCard system={system.data} />
        {canSources ? <CountsCard /> : null}
      </div>
      {system.data ? <SystemDetails data={system.data} /> : null}
    </div>
  );
}

function Kpis() {
  const { t, format } = useI18n();
  const overview = useQuery({ queryKey: queryKeys.admin.overview, queryFn: ({ signal }) => api.get<Overview>("/admin/overview", signal), refetchInterval: 60_000 });
  if (overview.isError) return <AdminCard><ErrorState message={overview.error.message} onRetry={() => overview.refetch()} /></AdminCard>;
  const d = overview.data;
  const bar = <SkelBar line="h-8" className="h-5 w-20" />;
  const sub = <SkelBar line="h-4" className="h-2.5 w-32" />;
  return (
    <div className={cn("grid grid-cols-2 gap-3 xl:grid-cols-4", !d && "ui-skeleton [--skel-bar:var(--border)]")} aria-busy={!d}>
      <StatTile label={t("admin.overview.users")} value={d ? format.num(d.users.total, 0) : bar} sub={d ? t("admin.overview.usersSub", { new: d.users.new7d, active: d.users.active7d }) : sub} />
      <StatTile label={t("admin.overview.traders")} value={d ? format.num(d.trackedTraders.total, 0) : bar} sub={d ? t("admin.overview.tradersSub", { imported: d.trackedTraders.imported, favorited: d.trackedTraders.favorited }) : sub} />
      <StatTile label={t("admin.overview.alerts")} value={d ? format.num(d.alerts24h.sent, 0) : bar} sub={d ? t("admin.overview.alertsSub", { failed: d.alerts24h.failed, dryRun: d.alerts24h.dryRun }) : sub} />
      <StatTile label={t("admin.overview.revenue")} tone={d && d.revenue30dUsd > 0 ? "positive" : undefined} value={d ? format.usd(d.revenue30dUsd, { digits: 2 }) : bar} sub={d ? t("admin.overview.revenueSub") : sub} />
    </div>
  );
}

function RevenueCard() {
  const { t, format } = useI18n();
  const [range, setRange] = useState<Range>("30d");
  const revenue = useQuery({
    queryKey: queryKeys.admin.revenue(range),
    queryFn: ({ signal }) => api.get<AdminRevenueResponse>(`/admin/revenue?range=${range}`, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 5 * 60_000,
  });
  const d = revenue.data;
  const usd = (v: number) => format.usd(v, { digits: 2 });
  const picker = d?.address ? (
    <Segmented variant="pill" tone="sub" value={range} onChange={setRange} label={t("admin.revenue.rangeTitle")}
      options={RANGES.map((r) => ({ value: r, label: t(`admin.revenue.ranges.${r}`) }))} />
  ) : null;
  let body: React.ReactNode;
  if (revenue.isError && !d) body = <ErrorState message={revenue.error.message} onRetry={() => revenue.refetch()} />;
  else if (!d) {
    body = (
      <div aria-hidden="true" className="ui-skeleton grid gap-4 [--skel-bar:var(--border)] md:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        <div className="grid grid-cols-2 gap-3">{[0, 1, 2, 3].map((i) => <StatTile key={i} label={<SkelBar className="h-2.5 w-16" />} value={<SkelBar line="h-8" className="h-5 w-20" />} />)}</div>
        <div className="h-[180px] rounded-[22px] bg-inset" />
      </div>
    );
  } else if (!d.address) {
    body = (
      <div className="flex flex-col items-start gap-3 rounded-[22px] bg-inset p-4">
        <p className="text-[15px] font-extrabold">{t("admin.revenue.noAddressTitle")}</p>
        <p className="type-caption max-w-prose">{t("admin.revenue.noAddressBody")}</p>
        <Link href="/admin/settings#revenue" className={buttonVariants({ variant: "inverse", size: "sm" })}><Settings />{t("admin.revenue.goSettings")}</Link>
      </div>
    );
  } else {
    body = (
      <div className="grid gap-4 md:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        <div className="grid grid-cols-2 content-start gap-3">
          <StatTile label={t("admin.revenue.builder")} tone="positive" value={usd(d.totals.builderUsd)} />
          <StatTile label={t("admin.revenue.referral")} tone="positive" value={usd(d.totals.referralUsd)} />
          <StatTile label={t("admin.revenue.claimedUnclaimed")} value={<span className="text-lg leading-7">{usd(d.totals.claimedUsd)} / {usd(d.totals.unclaimedUsd)}</span>} />
          <StatTile label={t("admin.revenue.referredUsersVolume")} value={<span className="text-lg leading-7">{format.num(d.totals.referredUsers, 0)} · {format.usd(d.totals.referredVolumeUsd, { compact: true })}</span>} />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          {d.daily.length === 0 ? <p className="flex h-[180px] items-center justify-center rounded-[22px] bg-inset text-sm font-bold text-muted-foreground">{t("admin.revenue.noData")}</p> : <DailyBars daily={d.daily} />}
          <p className="num type-caption">
            {t("admin.revenue.rangeTotal")} <span className="text-foreground">{usd(d.rangeUsd.builder + d.rangeUsd.referral)}</span>
            {" · "}{t("admin.revenue.builder")} {usd(d.rangeUsd.builder)} · {t("admin.revenue.referral")} {usd(d.rangeUsd.referral)}
            {" · "}{t("admin.revenue.builderFee")} {format.pct(d.builderFeeTenthsBps / 100_000, { digits: 3 })}
            {d.lastSnapshotAt ? ` · ${t("admin.revenue.lastSnapshot", { time: format.relative(d.lastSnapshotAt) })}` : ""}
          </p>
        </div>
      </div>
    );
  }
  return <AdminCard title={t("admin.revenue.cardTitle")} action={picker} aria-busy={!d}>{body}</AdminCard>;
}

/** Daily earnings as bars (builder below, referral above), newest at the right. */
function DailyBars({ daily }: { daily: AdminRevenueResponse["daily"] }) {
  const { t, format } = useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...daily.map((d) => d.builder + d.referral));
  const shown = hover === null ? null : daily[hover];
  return (
    <div className="relative">
      <div className="flex h-[180px] items-end gap-1" onPointerLeave={() => setHover(null)} role="img" aria-label={t("admin.revenue.daily")}>
        {daily.map((d, i) => {
          const total = d.builder + d.referral;
          return (
            <div key={d.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" onPointerEnter={() => setHover(i)}>
              <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-[8px] transition-opacity" style={{ height: `${Math.max(total > 0 ? 2 : 0, (total / max) * 100)}%`, opacity: hover === null || hover === i ? 1 : 0.5 }}>
                <div className="bg-primary" style={{ height: `${total ? (d.builder / total) * 100 : 0}%` }} />
                <div className="bg-primary/45" style={{ height: `${total ? (d.referral / total) * 100 : 0}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="num mt-1.5 flex justify-between text-[11px] font-bold text-muted-foreground">
        <span>{daily[0].day.slice(5).replace("-", "/")}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-primary" />{t("admin.revenue.builder")}</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-primary/45" />{t("admin.revenue.referral")}</span>
        </span>
        <span>{t("admin.revenue.today")}</span>
      </div>
      {shown ? (
        <div className="pointer-events-none absolute top-0 right-0 rounded-[16px] bg-popover px-3 py-2 text-xs font-bold shadow-[0_0_0_2px_var(--card-ring),var(--shadow-pop)]">
          <div className="num">{shown.day}</div>
          <div className="num text-positive">{format.usd(shown.builder + shown.referral, { digits: 2 })}</div>
        </div>
      ) : null}
    </div>
  );
}

type SystemQuery = { data?: AdminSystemOverview; isError: boolean; error: Error | null; refetch: () => unknown };

function stateTone(state: string): "positive" | "warning" {
  return state === "active" || state === "available" ? "positive" : "warning";
}

function ServiceCard({ system }: { system: SystemQuery }) {
  const { t, format } = useI18n();
  const d = system.data;
  if (system.isError && !d) return <AdminCard title={t("admin.health.title")}><ErrorState message={system.error?.message} onRetry={() => system.refetch()} /></AdminCard>;
  const worker = d?.worker.sample;
  const budget = worker?.budget ?? d?.api.budget;
  const used = budget ? Math.min(1, budget.weightLastMinute / Math.max(1, budget.effectiveBudgetPerMin)) : 0;
  return (
    <AdminCard title={t("admin.health.title")} aria-busy={!d}>
      {!d ? <RowsSkeleton rows={4} /> : (
        <Facts>
          <Fact label="API" tone="positive" value={t("admin.health.apiValue", { uptime: format.duration(d.api.uptimeSeconds) })} />
          <Fact label="Worker" tone={stateTone(d.worker.state)} value={worker ? t("admin.health.workerValue", { state: t(`monitoring.${d.worker.state}`), age: format.relative(worker.sampledAt) }) : t(`monitoring.${d.worker.state}`)} />
          <Fact label="PostgreSQL" tone={stateTone(d.database.state)} value={d.database.latencyMs === null ? t(`monitoring.${d.database.state}`) : t("admin.health.dbValue", { state: t(`monitoring.${d.database.state}`), ms: d.database.latencyMs })} />
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2.5 text-[15px] font-extrabold">
            <dt>{t("admin.health.budget")}</dt>
            <dd className="num">{budget ? `${format.num(budget.weightLastMinute, 0)} / ${format.num(budget.effectiveBudgetPerMin, 0)}` : "—"}</dd>
            <dd className="w-full" aria-hidden="true"><div className="cd-bar"><span className={used > 0.9 ? "bg-negative" : "bg-primary"} style={{ width: `${used * 100}%` }} /></div></dd>
          </div>
        </Facts>
      )}
    </AdminCard>
  );
}

function FreshnessCard({ system }: { system?: AdminSystemOverview }) {
  const { t, format } = useI18n();
  const heartbeat = system?.worker.sample?.heartbeat;
  const ago = (v: string | Date | null | undefined) => (v ? format.relative(v) : t("monitoring.never"));
  const archive = archiveState(system?.worker.sample?.switches?.archiveEnabled, heartbeat?.archive ?? undefined);
  const medianPool = heartbeat?.discovery?.medianVisibleAgeSeconds;
  return (
    <AdminCard title={t("admin.freshness.title")} aria-busy={!system}>
      {!system ? <RowsSkeleton rows={5} /> : (
        <Facts>
          <Fact label={t("admin.freshness.leaderboard")} tone={system.data?.freshness?.leaderboard === "stale" ? "warning" : undefined} value={ago(system.data?.leaderboardUpdatedAt)} />
          <Fact label={t("admin.freshness.pool")} value={medianPool === null || medianPool === undefined ? "—" : t("admin.freshness.medianAge", { age: format.duration(medianPool) })} />
          <Fact label={t("admin.freshness.snapshots")} value={ago(heartbeat?.lastSnapshotAt)} />
          <Fact label={t("admin.freshness.fills")} value={ago(heartbeat?.lastFillAt)} />
          <Fact label={t("admin.freshness.archive")} tone={archive === "error" || archive === "capped" ? "warning" : archive === "disabled" ? "muted" : undefined} value={t(`adminOps.system.archiveStates.${archive}`)} />
        </Facts>
      )}
    </AdminCard>
  );
}

function QueuesCard({ system }: { system?: AdminSystemOverview }) {
  const { t, format } = useI18n();
  const canCopy = usePermission("copy.read");
  const canJobs = usePermission("jobs.read");
  const copy = useAdminCopyOverview(canCopy);
  const jobs = useJobCounts(canJobs);
  const deliveries = system?.outbox?.find((q) => q.kind === "deliveries");
  const evaluations = system?.outbox?.find((q) => q.kind === "evaluations");
  const retention = system?.retention;
  return (
    <AdminCard title={t("admin.queues.title")} aria-busy={!system}>
      {!system ? <RowsSkeleton rows={5} /> : (
        <Facts>
          <Fact label={t("admin.queues.alerts")} tone={deliveries && deliveries.failed > 0 ? "negative" : undefined}
            value={deliveries ? t("admin.queues.pendingFailed", { pending: deliveries.pending, failed: deliveries.failed }) : "—"} />
          <Fact label={t("admin.queues.evaluations")} value={evaluations ? format.num(evaluations.pending, 0) : "—"} />
          {canCopy ? <Fact label={t("admin.queues.copySignals")} tone={copy.data && copy.data.outbox.failed > 0 ? "negative" : undefined} value={copy.data ? format.num(copy.data.outbox.pending, 0) : "—"} /> : null}
          {canJobs ? <Fact label={t("admin.queues.jobs")} tone={jobs.failed ? "negative" : undefined} value={jobs.ready ? t("admin.queues.runningFailed", { running: jobs.running, failed: jobs.failed }) : "—"} /> : null}
          <Fact label={t("admin.queues.retention")} value={retention?.lastFinishedAt ? t("admin.queues.lastRun", { time: format.relative(retention.lastFinishedAt) }) : t("adminOps.retention.never")} />
        </Facts>
      )}
      {canJobs ? <Link href="/admin/traders/jobs" className={cn(buttonVariants({ variant: "secondary", size: "default" }), "self-start")}>{t("admin.queues.viewJobs")}</Link> : null}
    </AdminCard>
  );
}

/** Running and failed backfill jobs (the list endpoint, counted; "100+" past a page). */
export function useJobCounts(enabled: boolean) {
  const count = (status: "running" | "pending" | "failed") => ({
    queryKey: queryKeys.admin.jobs.list(`count:${status}`),
    queryFn: ({ signal }: { signal: AbortSignal }) => api.get<BackfillJobsResponse>(`/admin/jobs?status=${status}&limit=100`, signal),
    refetchInterval: 30_000,
    enabled,
  });
  const running = useQuery(count("running"));
  const pending = useQuery(count("pending"));
  const failed = useQuery(count("failed"));
  const n = (q: typeof running) => (q.data ? (q.data.nextCursor ? "100+" : String(q.data.items.length)) : "—");
  return { ready: Boolean(running.data && failed.data), running: n(running), pending: n(pending), failed: failed.data?.items.length ? n(failed) : 0 };
}

function DeployCard({ system }: { system?: AdminSystemOverview }) {
  const { t, format } = useI18n();
  const canSettings = usePermission("settings.read");
  const runtime = useQuery({ queryKey: queryKeys.admin.settingsRuntime, queryFn: ({ signal }) => api.get<SettingsRuntime>("/admin/settings/runtime", signal), refetchInterval: 30_000, enabled: canSettings });
  // The worker runs the jobs, so its values are the ones that matter.
  const switches = system?.worker.sample?.switches ?? system?.api.switches;
  const tuning = system?.worker.sample?.tuning ?? system?.api.tuning;
  const chip = (label: string, value: React.ReactNode, key = label) => <span key={key} className="chip-md bg-inset">{label} · {value}</span>;
  return (
    <AdminCard title={t("admin.deploy.title")} aria-busy={!system}>
      {!system ? <RowsSkeleton rows={2} /> : (
        <div className="flex flex-wrap gap-2">
          {switches ? [
            chip(t("admin.deploy.copyMode"), switches.copyTradingMode),
            chip(t("admin.deploy.network"), switches.hyperliquidNetwork),
            chip(t("admin.deploy.archive"), switches.archiveEnabled ? t("admin.deploy.archiveOn", { cap: format.usd(switches.archiveMaxDailyUsd, { digits: 2 }) }) : t("adminOps.system.off")),
            chip("Telegram", t(switches.telegramDryRun ? "admin.deploy.dryRun" : "admin.deploy.live")),
            chip(t("admin.deploy.favorites"), switches.maxFavoritesPerUserDefault),
          ] : null}
          {tuning ? [
            chip(t("admin.deploy.weights"), `${tuning.weights.poolLedger} / ${tuning.weights.poolPerformance} / ${tuning.weights.history} / ${tuning.weights.backfill} / ${tuning.weights.cohort}`),
            chip(t("admin.deploy.discovery"), t("admin.deploy.discoveryValue", { pool: tuning.discovery.candidatePoolSize, board: tuning.discovery.leaderboardRefreshMinutes, members: tuning.discovery.cohortMembersPerTier, cohort: tuning.discovery.cohortRefreshMinutes })),
            chip(t("admin.deploy.retention"), tuning.retention.enabled ? t("admin.deploy.retentionValue", { snapshots: tuning.retention.snapshotDays, audit: tuning.retention.auditDays, queues: tuning.retention.queueDays }) : t("adminOps.system.off")),
          ] : null}
          {runtime.data ? <RuntimeChips data={runtime.data} /> : null}
        </div>
      )}
      <p className="type-caption">{t("admin.deploy.hint")}</p>
    </AdminCard>
  );
}

/** Whether a worker loop runs the saved settings: applied only with a
 * current, healthy acknowledgement of the saved revision. */
export function runtimeStatus(data: SettingsRuntime, consumer: "pool" | "leaderboard"): "unknown" | "stale" | "recovered" | "applied" | "pending" {
  const row = data.consumers.find((item) => item.consumer === consumer);
  const age = row ? Date.parse(data.sampledAt) - Date.parse(row.checkedAt) : Infinity;
  return data.state !== "active" || !row ? "unknown" : age > 180_000 || age < -5000 ? "stale" : row.recovered ? "recovered" : row.revision === data.savedRevision ? "applied" : "pending";
}

/** Whether the worker's pool and leaderboard loops run the saved settings (the old settings-page runtime panel). */
function RuntimeChips({ data }: { data: SettingsRuntime }) {
  const { t } = useI18n();
  return (["pool", "leaderboard"] as const).map((consumer) => {
    const row = data.consumers.find((item) => item.consumer === consumer);
    const status = runtimeStatus(data, consumer);
    return (
      <span key={consumer} className={cn("chip-md", status === "applied" ? "bg-tag-profit text-tag-profit-foreground" : "bg-tag-warning text-tag-warning-foreground")} title={row?.revision}>
        {t(`settingsOps.${consumer}`)} · {t(`settingsOps.${status}`)}
      </span>
    );
  });
}

function CountsCard() {
  const { t, format } = useI18n();
  const sources = useQuery({ queryKey: ["admin", "sources"], queryFn: ({ signal }) => api.get<AdminSources>("/admin/data-sources", signal), refetchInterval: 60_000 });
  const d = sources.data;
  return (
    <AdminCard title={t("admin.counts.title")} aria-busy={!d}>
      {sources.isError && !d ? <ErrorState message={sources.error.message} onRetry={() => sources.refetch()} /> : (
        <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6", !d && "ui-skeleton [--skel-bar:var(--border)]")}>
          {(d?.items ?? (["leaderboard", "discovery", "kol", "watched", "favorites", "imports"] as const).map((id) => ({ id, count: null, latestAt: null }))).map((item) => (
            <StatTile key={item.id} label={t(`sources.names.${item.id}`)} value={item.count === null ? <SkelBar line="h-8" className="h-5 w-12" /> : format.num(item.count, 0)}
              sub={item.latestAt ? format.relative(item.latestAt) : undefined} />
          ))}
        </div>
      )}
    </AdminCard>
  );
}

/** The old 系統 page's detail, folded: budgets, outbox, the feed, switches, retention. */
function SystemDetails({ data }: { data: AdminSystemOverview }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const heartbeat = data.worker.sample?.heartbeat;
  return (
    <section className="flex flex-col gap-4">
      <Button variant="secondary" className="self-start" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {t("admin.details.toggle")}
        <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
      </Button>
      {open ? (
        <div className="flex flex-col gap-4">
          <MonitoringDetails data={data} />
          <OperationalSwitchesPanel api={data.api.switches} worker={data.worker.sample?.switches} archive={heartbeat?.archive ?? undefined} />
          {heartbeat ? <WorkerHeartbeat data={heartbeat} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function RowsSkeleton({ rows }: { rows: number }) {
  return (
    <div aria-hidden="true" className="ui-skeleton divide-y-2 divide-dotted divide-border [--skel-bar:var(--raised)]">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex min-h-12 items-center justify-between py-2.5"><SkelBar className="h-3 w-24" /><SkelBar className="h-3 w-20" /></div>
      ))}
    </div>
  );
}
