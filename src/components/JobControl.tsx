"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { getJobState, runDailyJob } from "@/app/actions";
import { ago, time } from "@/lib/format";
import type { JobState } from "@/lib/runner";

import { Icon } from "./Icon";

export function JobControl({ initial, now, dataUpdatedAt }: { initial: JobState; now: number; dataUpdatedAt: number | null }) {
  const router = useRouter();
  const [state, setState] = useState(initial);

  const poll = useCallback(async () => {
    const s = await getJobState();
    setState(s);
    if (!s.running) router.refresh();
    return s.running;
  }, [router]);

  useEffect(() => {
    if (!state.running) return;
    const id = setInterval(async () => {
      if (!(await poll())) clearInterval(id);
    }, 3000);
    return () => clearInterval(id);
  }, [state.running, poll]);

  let text = state.running
    ? `Running since ${time(state.started_at).slice(11)} UTC`
    : state.finished_at
      ? `Last run ${ago(state.finished_at, now)}`
      : dataUpdatedAt
        ? `Data updated ${ago(dataUpdatedAt, now)}`
        : "Not run yet";
  if (state.error) text += " · failed";
  if (!state.running && state.next_scheduled_at) text += ` · next ${time(state.next_scheduled_at).slice(5)} UTC`;
  const tone = state.running ? "busy" : state.error ? "error" : "";

  return (
    <>
      <span
        className={`pill ${tone}`}
        role="status"
        title={state.error ?? (state.result ? JSON.stringify(state.result, null, 1) : "")}
      >
        <Icon name={state.running ? "loader" : state.error ? "alert" : "clock"} size={14} />
        <span className="hide-sm">{text}</span>
        <span className="sr-only sm-only">{text}</span>
      </span>
      <button
        className="primary"
        aria-label="Run daily job"
        disabled={state.running}
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
