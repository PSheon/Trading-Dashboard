"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { copyStreamEventSchemas, type WireCopyEvents } from "@trading-dashboard/shared/contracts";

import { backoffMs, readSseStream, SseParser, type SseEvent } from "@/lib/action-stream";
import { ApiError, openEventStream } from "@/lib/api";
import { copyStreamStatus, mergeCopyEvents, setCopyStreamStatus as setStatus, type CopyStreamStatus } from "@/lib/copy";
import { queryKeys } from "@/lib/query-keys";

export type { CopyStreamStatus };
export type CopyFeedEvent = WireCopyEvents["items"][number];

/** Three missed heartbeats (every ~15 s) → the stream is dead. */
const SILENCE_MS = 45_000;
const HEALTHY_MS = 30_000;
/** Overview, portfolio and history reads refresh at most this often on a burst. */
const REFRESH_DEBOUNCE_MS = 750;

export function useCopyStreamStatus(): CopyStreamStatus {
  return useSyncExternalStore(copyStreamStatus.subscribe, copyStreamStatus.get, () => "off");
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/** Applies one pushed event to the cached events list (de-duplicated by id). */
export function applyCopyEvent(previous: WireCopyEvents | undefined, event: CopyFeedEvent): WireCopyEvents {
  return mergeCopyEvents(previous, { items: [event], nextCursor: event.id, previousCursor: event.id, hasMore: false });
}

/**
 * Keeps the signed-in owner's copy events live with GET /me/copy/stream
 * (CopyDog's `portfolio-feed`) instead of the 15 s poll: fetch streaming
 * with the Authorization header, `Last-Event-ID` = the cached list's
 * cursor so a reconnect replays what was missed, de-duplicated by id. Each
 * event refreshes the overview, the portfolio and the copy's history, and
 * is handed to `onEvent` (toasts). Off in fixture mode (polling covers it).
 */
export function useCopyStream(opts: { enabled: boolean; eventsKey: readonly unknown[]; onEvent?: (event: CopyFeedEvent) => void }): void {
  const client = useQueryClient();
  const fixtures = process.env.NEXT_PUBLIC_API_FIXTURES === "1";
  const active = opts.enabled && !fixtures;
  const key = JSON.stringify(opts.eventsKey);
  const onEvent = opts.onEvent;

  useEffect(() => {
    if (!active) { setStatus("off"); return; }
    const eventsKey = JSON.parse(key) as readonly unknown[];
    const stop = new AbortController();
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (refresh) return;
      refresh = setTimeout(() => {
        refresh = undefined;
        void client.invalidateQueries({ queryKey: queryKeys.copy.all, predicate: (q) => q.queryKey[1] !== "events" });
        void client.invalidateQueries({ queryKey: queryKeys.wallet.history });
      }, REFRESH_DEBOUNCE_MS);
    };
    const handle = (evt: SseEvent) => {
      if (evt.event === "reset") {
        // More was missed than the server replays: reload the list.
        client.removeQueries({ queryKey: eventsKey, exact: true });
        void client.invalidateQueries({ queryKey: eventsKey, exact: true });
        scheduleRefresh();
        return;
      }
      if (evt.event !== "copy") return;
      let json: unknown;
      try { json = JSON.parse(evt.data); } catch { return; }
      const parsed = copyStreamEventSchemas.copy.safeParse(json);
      if (!parsed.success) return;
      const before = client.getQueryData<WireCopyEvents>(eventsKey);
      const seen = before?.items.some((e) => e.id === parsed.data.id) ?? false;
      // Only into a list that has loaded: an unloaded list reads the latest
      // events itself (this one included) when a page first shows it.
      if (before) client.setQueryData<WireCopyEvents>(eventsKey, applyCopyEvent(before, parsed.data));
      scheduleRefresh();
      if (!seen) onEvent?.(parsed.data);
    };
    void (async () => {
      let attempt = 0;
      setStatus("connecting");
      while (!stop.signal.aborted) {
        const connection = new AbortController();
        const abortConnection = () => connection.abort();
        stop.signal.addEventListener("abort", abortConnection, { once: true });
        let watchdog: ReturnType<typeof setInterval> | undefined;
        let retryAfter: number | undefined;
        try {
          const cursor = client.getQueryData<WireCopyEvents>(eventsKey)?.nextCursor;
          const res = await openEventStream("/me/copy/stream", { signal: connection.signal, lastEventId: cursor && cursor !== "0" ? cursor : undefined });
          const openedAt = Date.now();
          let heardAt = openedAt;
          setStatus("live");
          watchdog = setInterval(() => { if (Date.now() - heardAt > SILENCE_MS) connection.abort(); }, 5_000);
          await readSseStream(res.body!, handle, new SseParser(), () => { heardAt = Date.now(); }).catch(() => undefined);
          attempt = Date.now() - openedAt >= HEALTHY_MS ? 0 : attempt + 1;
        } catch (error) {
          if (stop.signal.aborted) break;
          if (error instanceof ApiError && [400, 401, 403].includes(error.status)) { setStatus("off"); break; }
          // Rate limited or busy: no sooner than the api's Retry-After (web audit L4).
          if (error instanceof ApiError && error.status === 429) retryAfter = error.retryAfterMs ?? 30_000;
          else if (error instanceof ApiError && error.status === 503 && error.retryAfterMs) retryAfter = Math.min(65_000, error.retryAfterMs);
          attempt += 1;
        } finally {
          if (watchdog) clearInterval(watchdog);
          stop.signal.removeEventListener("abort", abortConnection);
        }
        if (stop.signal.aborted) break;
        // Polling covers the gap; the next connection replays it.
        setStatus("down");
        await sleep(Math.max(retryAfter ?? 0, backoffMs(attempt - 1)), stop.signal);
      }
    })();
    return () => {
      stop.abort();
      if (refresh) clearTimeout(refresh);
      setStatus("off");
    };
  }, [active, client, key, onEvent]);
}
