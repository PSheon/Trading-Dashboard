"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { getJobState, runDailyJob } from "@/app/actions";
import { ago, time } from "@/lib/format";
import type { JobState } from "@/lib/runner";

export function JobControl({ initial, now }: { initial: JobState; now: number }) {
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
    ? `Running since ${time(state.started_at)} UTC…`
    : state.finished_at
      ? `Last run ${ago(state.finished_at, now)}`
      : "";
  if (state.error) text += " · failed";
  if (state.next_scheduled_at) text += ` · next ${time(state.next_scheduled_at)} UTC`;

  return (
    <>
      <span className={`status ${state.error ? "error" : ""}`} title={state.error ?? (state.result ? JSON.stringify(state.result, null, 1) : "")}>
        {text}
      </span>
      <button
        disabled={state.running}
        onClick={async () => {
          const r = await runDailyJob();
          setState(r.state);
          if (!r.started) alert("A run is already in progress.");
        }}
      >
        Run daily job
      </button>
    </>
  );
}
