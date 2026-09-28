"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { getActivity } from "@/app/actions";
import { runStatus } from "@/lib/activity";
import { ago, time } from "@/lib/format";
import type { Activity } from "@/lib/progress";

import { Icon } from "./Icon";

const SHOWN = 12;
const LABEL = { running: "Running", stalled: "Stalled?", ok: "Finished", failed: "Finished with errors", none: "" } as const;

/** The latest job run, live while it runs; refreshes the page's data when it ends. */
export function ActivityPanel({ initial, now: serverNow }: { initial: Activity | null; now: number }) {
  const router = useRouter();
  const [activity, setActivity] = useState(initial);
  const [now, setNow] = useState(serverNow);
  const status = runStatus(activity, now);

  useEffect(() => {
    if (status !== "running") return;
    const id = setInterval(async () => {
      const next = await getActivity();
      setNow(Math.floor(Date.now() / 1000));
      setActivity(next);
      if (next && next.outcome !== "running") router.refresh();
    }, 5000);
    return () => clearInterval(id);
  }, [status, router]);

  if (!activity) return null;
  const pct = activity.total ? Math.min(100, Math.round((activity.done / activity.total) * 100)) : null;
  return (
    <section className="card activity" aria-label="Latest job run" aria-live="polite">
      <div className="card-head">
        <h2>
          <Icon name={status === "running" ? "loader" : status === "ok" ? "check" : "alert"} />
          Latest run <span className="muted">{activity.source} · started {ago(activity.started_at, now)}</span>
        </h2>
        <span className={`badge ${status === "ok" ? "up" : status === "running" ? "" : "warn"}`}>
          {LABEL[status]}
          {activity.errors ? ` · ${activity.errors} errors` : ""}
        </span>
      </div>
      {status === "running" && (
        <div className="progress">
          <div className="progress-label">
            <span>{activity.step}</span>
            <span className="num">{activity.total ? `${activity.done} / ${activity.total}` : "…"}</span>
          </div>
          <div className="progress-track">
            <div className="progress-bar" style={{ width: pct === null ? "30%" : `${pct}%` }} data-indeterminate={pct === null || undefined} />
          </div>
        </div>
      )}
      <ol className="log">
        {activity.log.slice(-SHOWN).reverse().map((e, i) => (
          <li key={`${e.at}-${i}`} className={e.level === "error" ? "error" : undefined}>
            <span className="num muted">{time(e.at).slice(11)}</span>
            <span className="badge">{e.step}</span>
            <span>{e.message}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
