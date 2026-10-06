"use client";
import { useSaveToast } from "@/lib/use-action-toast";
import { useState } from "react";
import { Link } from "@/i18n/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { Panel, PanelSkeleton } from "@/components/page";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { api, ApiError } from "@/lib/api";
import { usePermission } from "@/lib/auth";
import type { BackfillJob, BackfillJobsResponse } from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";

export function AdminJobs() {
  const { t } = useI18n();
  const canRetry = usePermission("jobs.retry");
  const [status, setStatus] = useState<BackfillJob["status"] | "">("");
  const [cursors, setCursors] = useState<number[]>([]);
  const client = useQueryClient();
  const params = new URLSearchParams({ limit: "25" });
  if (status) params.set("status", status);
  if (cursors.length) params.set("beforeId", String(cursors.at(-1)));
  const qs = params.toString();
  const jobs = useQuery({
    queryKey: queryKeys.admin.jobs.list(qs),
    queryFn: ({ signal }) =>
      api.get<BackfillJobsResponse>(`/admin/jobs?${qs}`, signal),
    refetchInterval: 5000,
  });
  const saved = useSaveToast();
  const retry = useMutation({
    mutationFn: (job: BackfillJob) =>
      api.post<BackfillJob>(`/admin/jobs/${job.id}/retry`, {
        expectedVersion: job.version,
      }),
    onSettled: () =>
      client.invalidateQueries({ queryKey: queryKeys.admin.jobs.all }),
  });
  return (
    <section className="space-y-4" aria-labelledby="jobs-title">
      <div>
        <h2 id="jobs-title" className="type-h2">
          {t("jobs.title")}
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {t("jobs.hint")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Select
          size="sm"
          label={t("jobs.filter")}
          value={status}
          onValueChange={(value) => {
            setStatus(value as typeof status);
            setCursors([]);
            retry.reset();
          }}
          options={[{ value: "", label: t("jobs.all") }, ...(["pending", "running", "completed", "failed"] as const).map((s) => ({ value: s, label: t(`jobs.${s}`) }))]}
        />
        <Button
          variant="secondary"
          loading={jobs.isFetching} disabled={!(jobs.isFetching) && (jobs.isFetching)}
          onClick={() => void jobs.refetch()}
        >
          {t("jobs.refresh")}
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("jobs.automatic")} {t("jobs.historyHint")}
      </p>
      {retry.isSuccess && (
        <p
          role="status"
          className="rounded-xl bg-positive-soft p-3 text-sm text-positive"
        >
          {t("jobs.queued")}
        </p>
      )}
      {retry.isError && (
        <p
          role="alert"
          className="rounded-xl bg-negative-soft p-3 text-sm text-negative"
        >
          {t(
            retry.error instanceof ApiError && retry.error.status === 409
              ? "jobs.conflict"
              : "jobs.requestFailed",
          )}
        </p>
      )}
      {jobs.isError && (
        <p
          role="alert"
          className="rounded-xl bg-warning/10 p-3 text-sm text-warning"
        >
          {t("jobs.stale")}
        </p>
      )}
      {!jobs.data && !jobs.isError ? (
        <PanelSkeleton rows={5} />
      ) : jobs.data?.items.length === 0 ? (
        <Panel className="p-8 text-center text-sm text-muted-foreground">
          {t("jobs.empty")}
        </Panel>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {jobs.data?.items.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              now={jobs.dataUpdatedAt}
              canRetry={canRetry}
              busy={jobs.isError || retry.isPending}
              onRetry={() => retry.mutate(job, saved())}
            />
          ))}
        </div>
      )}
      <nav
        aria-label={t("jobs.title")}
        className="flex items-center justify-between gap-3"
      >
        <Button
          variant="secondary"
          disabled={cursors.length === 0 || jobs.isFetching}
          onClick={() => {
            setCursors((c) => c.slice(0, -1));
            retry.reset();
          }}
        >
          {t("jobs.previous")}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t("jobs.page", { value: cursors.length + 1 })}
        </span>
        <Button
          variant="secondary"
          disabled={!jobs.data?.nextCursor || jobs.isFetching || jobs.isError}
          onClick={() => {
            if (jobs.data?.nextCursor)
              setCursors((c) => [...c, jobs.data!.nextCursor!]);
            retry.reset();
          }}
        >
          {t("jobs.next")}
        </Button>
      </nav>
    </section>
  );
}
export function JobCard({
  job,
  canRetry,
  busy,
  now,
  onRetry,
}: {
  job: BackfillJob;
  canRetry: boolean;
  busy: boolean;
  now: number;
  onRetry: () => void;
}) {
  const { t, format } = useI18n();
  const time = (v: string | null) =>
    v ? format.dateTime(v) : t("jobs.unknown");
  const expired =
    job.status === "running" &&
    job.leaseExpiresAt !== null &&
    Date.parse(job.leaseExpiresAt) < now;
  return (
    <Panel className="card-pad min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          #{job.id} ·{" "}
          {t(job.source === "import" ? "jobs.imported" : "jobs.favorite")}
        </span>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-semibold",
            job.status === "completed"
              ? "bg-tag-profit text-tag-profit-foreground"
              : job.status === "failed"
                ? "bg-tag-loss text-tag-loss-foreground"
                : "bg-raised text-foreground",
          )}
        >
          {t(`jobs.${job.status}`)}
        </span>
      </div>
      <Link
        href={`/trader/${job.address}`}
        className="mt-3 block break-all font-mono text-xs underline decoration-border underline-offset-4"
      >
        {job.address}
      </Link>
      {expired && (
        <p className="mt-3 text-xs text-warning">{t("jobs.expired")}</p>
      )}
      <dl className="mt-3 divide-y-2 divide-dotted divide-border text-xs">
        <Metric
          label={t("jobs.attempts")}
          value={`${job.runAttempts} / 3 · ${job.attempts}`}
        />
        <Metric label={t("jobs.created")} value={time(job.createdAt)} />
        <Metric label={t("jobs.started")} value={time(job.startedAt)} />
        <Metric
          label={t(
            job.status === "running"
              ? "jobs.lease"
              : job.status === "pending"
                ? "jobs.available"
                : "jobs.completedAt",
          )}
          value={time(
            job.status === "running"
              ? job.leaseExpiresAt
              : job.status === "pending"
                ? job.availableAt
                : job.completedAt,
          )}
        />
        <Metric
          label={t("jobs.fills")}
          value={
            job.fillsFetched === null
              ? t("jobs.unknown")
              : format.num(job.fillsFetched, 0)
          }
        />
        {job.lastErrorCode && (
          <Metric
            label={t("jobs.error")}
            value={t(`jobs.${job.lastErrorCode}`)}
          />
        )}
      </dl>
      {canRetry && job.status === "failed" && (
        <Button
          className="mt-4"
          variant="secondary"
          disabled={busy}
          aria-label={t("jobs.retryJob", { id: job.id })}
          onClick={onRetry}
        >
          {t("jobs.retry")}
        </Button>
      )}
    </Panel>
  );
}
function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="num text-right">{value}</dd>
    </div>
  );
}
