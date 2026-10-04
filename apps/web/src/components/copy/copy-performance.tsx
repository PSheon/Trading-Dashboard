"use client";

import { useState } from "react";
import { useI18n } from "@/i18n/provider";
import { useCopyPerformance, type CopyPerformanceView, type CopyPerformanceWindow } from "@/lib/copy";

/** Actual timestamps retain gaps; unavailable marks never become a zero. */
export function equityPaths(points: CopyPerformanceView["points"], width = 400, height = 120, bucketMs = Infinity): string[] {
  const valid = points.filter((p) => p.equity !== null && Number.isFinite(p.equity) && Number.isFinite(Date.parse(p.time)));
  if (!valid.length) return [];
  const times = valid.map((p) => Date.parse(p.time));
  const values = valid.map((p) => p.equity!);
  const first = Math.min(...times), span = Math.max(...times) - first || 1;
  const low = Math.min(...values), range = Math.max(...values) - low;
  const paths: string[] = [];
  let path = "";
  let previousTime: number | null = null;
  for (const p of points) {
    if (p.equity === null || !Number.isFinite(p.equity) || !Number.isFinite(Date.parse(p.time))) {
      if (path) paths.push(path);
      path = "";
      previousTime = null;
      continue;
    }
    const time = Date.parse(p.time);
    if (previousTime !== null && Number.isFinite(bucketMs) && Math.floor(time / bucketMs) - Math.floor(previousTime / bucketMs) > 1) {
      if (path) paths.push(path);
      path = "";
    }
    const x = 4 + ((Date.parse(p.time) - first) / span) * (width - 8);
    const y = range ? height - 4 - ((p.equity - low) / range) * (height - 8) : height / 2;
    path += `${path ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    previousTime = time;
  }
  if (path) paths.push(path);
  return paths;
}

export function performanceBucketMs(data: Pick<CopyPerformanceView, "from" | "to">): number {
  return Math.max(60_000, Math.ceil((Date.parse(data.to) - Date.parse(data.from)) / 1000 / 60_000) * 60_000);
}

export function performanceIsStale(data: CopyPerformanceView, now = Date.now()): boolean {
  const latest = data.coverage.lastSnapshotAt;
  return latest !== null && now - Date.parse(latest) > 180_000;
}

export function EquityHistory({ data, compact = false }: { data: CopyPerformanceView; compact?: boolean }) {
  const { t, format } = useI18n();
  const paths = equityPaths(data.points, 400, 120, performanceBucketMs(data));
  if (!paths.length) return <p className="text-xs text-muted-foreground">{t("copyUpdates.equityEmpty")}</p>;
  const stale = performanceIsStale(data);
  return <div>
    <svg viewBox="0 0 400 120" role="img" aria-label={t("copyUpdates.equityAria")} className={compact ? "h-8 w-full" : "h-36 w-full"} preserveAspectRatio="none">
      {paths.map((d, i) => <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={compact ? 3 : 2} vectorEffect="non-scaling-stroke" className="text-primary-text" />)}
      {paths.filter((path) => !path.includes("L")).map((path, i) => {
        const [x, y] = path.slice(1).split(",").map(Number);
        return <circle key={`point-${i}`} cx={x} cy={y} r="3" fill="currentColor" className="text-primary-text" />;
      })}
    </svg>
    {!compact ? <div className="mt-2 flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground">
      <span>{t("copyUpdates.equityHint")}</span>
      <span>{stale ? (t("copyUpdates.snapshotStale")) : !data.coverage.complete ? (t("copyUpdates.partialHistory")) : (t("copyUpdates.snapshotHistory"))}{data.coverage.lastSnapshotAt ? ` · ${format.dateTime(data.coverage.lastSnapshotAt)}` : ""}</span>
    </div> : stale ? <span className="text-[10px] text-muted-foreground">{t("copyUpdates.stale")}</span> : null}
  </div>;
}

export function CopyEquitySparkline({ strategyId }: { strategyId: number }) {
  const query = useCopyPerformance(strategyId);
  const { t } = useI18n();
  if (!query.data) return <span className="text-xs text-muted-foreground">{query.isError ? (t("copyUpdates.unavailable")) : "—"}</span>;
  return <EquityHistory data={query.data} compact />;
}

export function CopyPerformance({ strategyId }: { strategyId: number }) {
  const [window, setWindow] = useState<CopyPerformanceWindow>("7d");
  const query = useCopyPerformance(strategyId, window);
  const { t, format } = useI18n();
  const today = query.data?.todayPnl;
  return <section className="orbit-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="text-sm font-bold">{t("copyUpdates.equityTitle")}</h3>
      <div className="flex gap-1" aria-label={t("copyUpdates.historyWindow")}>
        {(["1d", "7d", "30d", "all"] as const).map((value) => <button key={value} type="button" aria-pressed={window === value} onClick={() => setWindow(value)} className={`rounded-full px-3 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${window === value ? "bg-primary text-primary-foreground" : "bg-raised text-muted-foreground"}`}>{value === "all" ? (t("copyUpdates.all")) : value}</button>)}
      </div>
    </div>
    <p className="my-3 text-xs text-muted-foreground">{t("copyUpdates.todayPnl")} <strong className="num ml-2 text-foreground">{today === null || today === undefined ? "—" : format.usd(today, { sign: true, digits: 2 })}</strong></p>
    {query.isError ? <p role="status" className="mb-2 text-xs text-muted-foreground">{t("copyUpdates.historyError")} <button type="button" onClick={() => query.refetch()} className="underline">{t("copyUpdates.retry")}</button></p> : null}
    {query.data ? <EquityHistory data={query.data} /> : <p className="py-8 text-center text-xs text-muted-foreground">{query.isPending ? (t("copyUpdates.snapshotsLoading")) : "—"}</p>}
  </section>;
}
