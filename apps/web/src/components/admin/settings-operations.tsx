"use client";
import { useQuery } from "@tanstack/react-query";
import type { AdminSettings, SettingsRuntime } from "@/lib/contracts";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { Panel, Skeleton } from "@/components/page";
import { Button } from "@/components/ui/button";

export function SettingsImpact({ section, original, value }: { section: keyof AdminSettings; original: AdminSettings[keyof AdminSettings]; value: AdminSettings[keyof AdminSettings] }) {
  const { t } = useI18n();
  const previous = original as unknown as Record<string, unknown>;
  const changed = Object.entries(value).filter(([key, next]) => JSON.stringify(previous[key]) !== JSON.stringify(next));
  return <section className="space-y-3 rounded-xl border border-primary/25 bg-primary/5 p-4" aria-label={t("settingsOps.preview")}>
    <h3 className="text-sm font-semibold">{t("settingsOps.preview")}</h3>
    <p className="text-xs leading-relaxed text-muted-foreground">{t("settingsOps.previewHint")} {t(`settingsOps.${section}Impact`)}</p>
    <dl className="space-y-3 text-xs">{changed.map(([key, next]) => <div key={key}>
      <dt className="font-medium">{t(`settingsOps.fields.${key}` as MessageKey)}</dt>
      <dd className="mt-1 grid gap-2 sm:grid-cols-2">
        <div><span className="text-muted-foreground">{t("settingsOps.before")}</span><pre className="mt-1 whitespace-pre-wrap break-all font-sans">{JSON.stringify(previous[key], null, 2)}</pre></div>
        <div><span className="text-muted-foreground">{t("settingsOps.after")}</span><pre className="mt-1 whitespace-pre-wrap break-all font-sans">{JSON.stringify(next, null, 2)}</pre></div>
      </dd>
    </div>)}</dl>
  </section>;
}

export function SettingsRuntimePanel() {
  const { t } = useI18n();
  const query = useQuery({ queryKey: queryKeys.admin.settingsRuntime,
    queryFn: ({ signal }) => api.get<SettingsRuntime>("/admin/settings/runtime", signal), refetchInterval: 15_000 });
  return <Panel className="space-y-3 p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">{t("settingsOps.runtime")}</h2>
      <Button type="button" variant="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>{t("settingsOps.refresh")}</Button></div>
    <p className="text-xs leading-relaxed text-muted-foreground">{t("settingsOps.runtimeHint")}</p>
    {query.isError ? <p role="alert" className="text-sm text-warning">{t("settingsOps.unavailable")}</p> : query.data ? <SettingsRuntimeDetails data={query.data} /> : <Skeleton className="h-32" />}
  </Panel>;
}
export function SettingsRuntimeDetails({ data }: { data: SettingsRuntime }) {
  const { t, format } = useI18n();
  return <div className="space-y-3 text-xs">
    <p>{t("settingsOps.savedRevision")} · <code title={data.savedRevision}>{data.savedRevision.slice(0, 12)}</code></p>
    <p className="break-all text-muted-foreground">Worker · {data.state}{data.instanceId ? ` · ${data.instanceId}` : ""}</p>
    <div className="grid gap-3 sm:grid-cols-2">{(["pool", "leaderboard"] as const).map(consumer => {
      const row = data.consumers.find(item => item.consumer === consumer);
      const age = row ? Date.parse(data.sampledAt) - Date.parse(row.checkedAt) : Infinity;
      const status = data.state !== "active" || !row ? "unknown"
        : age > 180_000 || age < -5000 ? "stale" : row.recovered ? "recovered" : row.revision === data.savedRevision ? "applied" : "pending";
      return <div key={consumer} className="space-y-2 rounded-lg bg-raised p-3">
        <h3 className="font-medium">{t(`settingsOps.${consumer}`)}</h3><p className={status === "applied" ? "text-positive" : "text-warning"}>{t(`settingsOps.${status}`)}</p>
        {row && <><p>{t("settingsOps.checkedAt")} · {format.dateTime(row.checkedAt)}</p><code title={row.revision}>{row.revision.slice(0, 12)}</code>
          <p className="text-muted-foreground">{consumer === "pool" ? `${t("settingsOps.candidatePoolSize")}: ${row.candidatePoolSize} · ${t("settingsOps.poolWeightPerMinute")}: ${row.poolWeightPerMinute}` : `${t("settingsOps.fields.leaderboardRefreshMinutes")}: ${row.leaderboardRefreshMinutes}`}</p></>}
      </div>;
    })}</div>
  </div>;
}
