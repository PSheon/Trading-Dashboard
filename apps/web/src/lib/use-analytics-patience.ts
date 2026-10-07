"use client";

import { useEffect, useState } from "react";

import { isComputing, isUnavailable } from "@/lib/queries";

/** How long a figure waits on a busy analytics read before it says so. */
export const ANALYTICS_PATIENCE_MS = 30_000;

type AnalyticsQuery = Parameters<typeof isUnavailable>[0] & { refetch: () => unknown };

/**
 * A trader-page figure's wait on the analytics read, bounded in time as
 * well as in retries: the api's Retry-After (up to 65 s a time) stretched
 * the three busy retries past a minute, and the phone's 勝率 tile stayed a
 * skeleton the whole while (Stage, 2026-10-07, A5). After
 * `ANALYTICS_PATIENCE_MS` of computing it is `unavailable` (「—」 and 重試);
 * the read goes on and a later answer still fills in.
 */
export function useAnalyticsPatience(query: AnalyticsQuery, ms = ANALYTICS_PATIENCE_MS): { computing: boolean; unavailable: boolean; retry: () => void } {
  const computing = isComputing(query);
  const [waitedOut, setWaitedOut] = useState(false);
  const [round, setRound] = useState(0);
  // An answer (or a failure) ends the wait; the next wait starts afresh.
  if (!computing && waitedOut) setWaitedOut(false);
  useEffect(() => {
    if (!computing) return;
    const timer = setTimeout(() => setWaitedOut(true), ms);
    return () => clearTimeout(timer);
  }, [computing, ms, round]);
  const out = computing && waitedOut;
  return {
    computing: computing && !out,
    unavailable: isUnavailable(query) || out,
    retry: () => {
      setWaitedOut(false);
      setRound((n) => n + 1);
      void query.refetch();
    },
  };
}
