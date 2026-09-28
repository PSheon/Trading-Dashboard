"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { getActivity, runDailyJob } from "@/app/actions";
import { runStatus } from "@/lib/activity";
import { ago, time } from "@/lib/format";
import type { Activity } from "@/lib/progress";
import type { JobState } from "@/lib/runner";

import { Icon } from "./Icon";

/**
 * Job status in the app bar. It reads the shared activity file, so a run
 * started anywhere (this page, the schedule, the CLI) shows here, and the
 * button stays disabled while any run is going.
 */
export function JobControl({
  initial,
  initialActivity,
  now: serverNow,
  dataUpdatedAt,
}: {
  initial: JobState;
  initialActivity: Activity | null;
  now: number;
  dataUpdatedAt: number | null;
}) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [activity, setActivity] = useState(initialActivity);
  const [now, setNow] = useState(serverNow);
  const status = runStatus(activity, now);
  const running = state.running || status === "running";

  useEffect(() => {
    if (!running) return;
    const id = setInterval(async () => {
      const next = await getActivity();
      setNow(Math.floor(Date.now() / 1000));
      setActivity(next);
      if (next && next.outcome !== "running") {
        setState((s) => ({ ...s, running: false }));
        router.refresh();
      }
    }, 5000);
    return () => clearInterval(id);
  }, [running, router]);

  let text: string;
  if (status === "running" && activity) {
    text = activity.total ? `${activity.step} ${activity.done}/${activity.total}` : `${activity.step}…`;
  } else if (state.running) {
    text = "Starting…";
  } else if (status === "stalled" && activity) {
    text = `No progress since ${ago(activity.updated_at, now)}`;
  } else if (activity?.finished_at) {
    text = `Last run ${ago(activity.finished_at, now)}${activity.errors ? ` · ${activity.errors} errors` : ""}`;
  } else if (dataUpdatedAt) {
    text = `Data updated ${ago(dataUpdatedAt, now)}`;
  } else {
    text = "Not run yet";
  }
  if (!running && state.next_scheduled_at) text += ` · next ${time(state.next_scheduled_at).slice(5)} UTC`;
  const tone = running ? "busy" : status === "failed" || status === "stalled" ? "error" : "";

  return (
    <>
      <span className={`pill ${tone}`} role="status">
        <Icon name={running ? "loader" : tone === "error" ? "alert" : "clock"} size={14} />
        <span className="hide-sm">{text}</span>
        <span className="sr-only sm-only">{text}</span>
      </span>
      <button
        className="primary"
        aria-label="Run daily job"
        disabled={running}
        title={running ? "A run is in progress" : undefined}
        onClick={async () => {
          const r = await runDailyJob();
          setState(r.state);
          if (!r.started) alert("A run is already in progress.");
        }}
      >
        <Icon name="play" size={14} />
        <span className="hide-sm">Run daily job</span>
      </button>
    </>
  );
}
