"use client";

import { cn } from "cn";

import { useI18n } from "@/i18n/provider";
import { coinLabel, usdCompact } from "@/lib/format";
import type { WireChartSnapshots } from "@trading-dashboard/shared/contracts";

type Snapshot = WireChartSnapshots["snapshots"][number];

/** The snapshot in force at `time`: the last one at or before it, if it is
 * no older than about two of the window's intervals (else the chart's time
 * has no snapshot, e.g. before the trader was watched). */
export function snapshotAt(data: Pick<WireChartSnapshots, "snapshots"> | undefined, time: number | null): Snapshot | null {
  if (!data || time === null || data.snapshots.length === 0) return null;
  const list = data.snapshots;
  let found: Snapshot | null = null;
  for (const s of list) {
    if (s.t <= time) found = s;
    else break;
  }
  if (!found) return null;
  const spacing = list.length > 1 ? (list.at(-1)!.t - list[0]!.t) / (list.length - 1) : 10 * 60_000;
  return time - found.t <= Math.max(15 * 60_000, spacing * 2) ? found : null;
}

/**
 * What the trader held at the chart's hovered time (CopyDog's
 * chart-snapshots): up to five positions, largest first. Shown only for a
 * watched trader (one with snapshots); otherwise nothing.
 */
export function ChartSnapshotStrip({ data, time, className }: { data: WireChartSnapshots | undefined; time: number | null; className?: string }) {
  const { t, format } = useI18n();
  if (!data?.coverageStart || data.snapshots.length === 0) return null;
  const snap = snapshotAt(data, time);
  return (
    <div className={cn("flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2 text-xs", className)} data-testid="chart-snapshot" aria-live="polite">
      {time === null ? (
        <span className="text-muted-foreground">{t("chartSnap.hint")}</span>
      ) : !snap ? (
        <span className="text-muted-foreground">{t("chartSnap.none")}</span>
      ) : (
        <>
          <span className="font-semibold">{t("chartSnap.at", { time: format.dateTime(snap.t) })}</span>
          {snap.n === 0 ? <span className="text-muted-foreground">{t("chartSnap.flat")}</span> : null}
          {snap.positions.slice(0, 5).map((p) => (
            <span key={p.coin} className="inline-flex items-center gap-1.5">
              <span className="font-semibold">{coinLabel(p.coin)}</span>
              <span className={p.szi > 0 ? "text-positive" : "text-negative"}>{t(p.szi > 0 ? "trader.sideLong" : "trader.sideShort")}</span>
              <span className="num text-muted-foreground">{p.notional === null ? "—" : usdCompact(p.notional)}</span>
              {p.upnl !== null ? <span className={cn("num", p.upnl >= 0 ? "text-positive" : "text-negative")}>{usdCompact(p.upnl, { sign: true })}</span> : null}
            </span>
          ))}
          {snap.n > 5 ? <span className="text-muted-foreground">{t("chartSnap.more", { count: snap.n - 5 })}</span> : null}
        </>
      )}
    </div>
  );
}
