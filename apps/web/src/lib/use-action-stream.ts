"use client";

import { queryKeys } from "@/lib/query-keys";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { actionStreamEventSchemas, type ActionFeedItem } from "@/lib/contracts";

import { ApiError, openEventStream } from "@/lib/api";
import {
  actionsQueryString,
  applyStreamEvent,
  backoffMs,
  newestId,
  parseActionsQuery,
  readSseStream,
  SseParser,
  streamQueryString,
  type ActionsParams,
  type SseEvent,
  type StreamEventName,
} from "@/lib/action-stream";

/**
 * - `connecting`: first attempt in flight;
 * - `live`: the stream is open (polling slows to a safety net);
 * - `down`: between reconnect attempts (polling at full speed covers it);
 * - `off`: not streaming (disabled, fixtures, or refused for good: 400/401/403).
 */
export type StreamStatus = "connecting" | "live" | "down" | "off";

/** Three missed heartbeats (sent every ~15 s) → treat the stream as dead. */
const SILENCE_MS = 45_000;
/** A connection that lasted this long resets the backoff. */
const HEALTHY_MS = 30_000;
/** How long a newly arrived row stays highlighted. */
const HIGHLIGHT_MS = 2_500;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/** Applies one stream event to every cached first-page /actions list;
 * returns whether this stream's own list gained the row. */
export function applyToCaches(client: QueryClient, ownKey: string, streamScope: "all" | "favorites", event: StreamEventName, item: ActionFeedItem): boolean {
  let addedToOwn = false;
  for (const [key, data] of client.getQueriesData<ActionFeedItem[]>({ queryKey: queryKeys.actions.all })) {
    const qs = key[1];
    if (typeof qs !== "string" || !data) continue;
    const target = parseActionsQuery(qs);
    if (target.paged) continue;
    const next = applyStreamEvent(data, target, streamScope, event, item);
    if (!next) continue;
    client.setQueryData(key, next);
    if (qs === ownKey && event === "action" && !data.some((row) => String(row.id) === String(item.id))) addedToOwn = true;
  }
  return addedToOwn;
}

/**
 * Keeps the cached GET /actions list for `params` live with
 * GET /actions/stream: fetch streaming (so the Authorization header goes
 * along), reconnect with backoff, resume with `Last-Event-ID`. Starts once
 * the list has loaded (`enabled`), so the resume cursor covers the gap
 * between the list's snapshot and the stream opening.
 */
export function useActionStream(params: ActionsParams, enabled: boolean): { status: StreamStatus; highlight: ReadonlySet<string> } {
  const client = useQueryClient();
  const listKey = actionsQueryString(params);
  const streamQs = streamQueryString(params);
  const scope = params.scope ?? "all";
  const fixtures = process.env.NEXT_PUBLIC_API_FIXTURES === "1";
  const active = enabled && !fixtures && !params.before;
  const [status, setStatus] = useState<StreamStatus>("off");
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  useEffect(() => {
    // Inactive reads as "off" (see the return value); nothing to run.
    if (!active) return;
    const stop = new AbortController();
    const flash = (id: string) => {
      setHighlight((prev) => new Set(prev).add(id));
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        setHighlight((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, HIGHLIGHT_MS);
      timers.current.add(timer);
    };
    const onEvent = (evt: SseEvent) => {
      if (evt.event === "reset") {
        void client.invalidateQueries({ queryKey: queryKeys.actions.list(listKey) });
        return;
      }
      if (evt.event !== "action" && evt.event !== "update") return;
      let json: unknown;
      try { json = JSON.parse(evt.data); } catch { return; }
      const parsed = actionStreamEventSchemas[evt.event].safeParse(json);
      if (!parsed.success) return; // off-contract event: ignored, polling still covers
      if (applyToCaches(client, listKey, scope, evt.event, parsed.data as ActionFeedItem)) flash(String(parsed.data.id));
    };

    void (async () => {
      let attempt = 0;
      let lastEventId: string | undefined;
      setStatus("connecting");
      while (!stop.signal.aborted) {
        const connection = new AbortController();
        const abortConnection = () => connection.abort();
        stop.signal.addEventListener("abort", abortConnection, { once: true });
        let watchdog: ReturnType<typeof setInterval> | undefined;
        let retryAfter: number | undefined;
        try {
          const cursor = lastEventId ?? newestId(client.getQueryData<ActionFeedItem[]>(queryKeys.actions.list(listKey)));
          const res = await openEventStream(`/actions/stream${streamQs ? `?${streamQs}` : ""}`, { signal: connection.signal, lastEventId: cursor });
          const openedAt = Date.now();
          let heardAt = openedAt;
          setStatus("live");
          watchdog = setInterval(() => { if (Date.now() - heardAt > SILENCE_MS) connection.abort(); }, 5_000);
          const parser = new SseParser();
          await readSseStream(res.body!, onEvent, parser, () => { heardAt = Date.now(); }).catch(() => undefined);
          lastEventId = parser.lastEventId ?? cursor;
          attempt = Date.now() - openedAt >= HEALTHY_MS ? 0 : attempt + 1;
        } catch (error) {
          if (stop.signal.aborted) break;
          if (error instanceof ApiError && [400, 401, 403].includes(error.status)) {
            setStatus("off"); // won't get better by retrying; polling stays
            break;
          }
          if (error instanceof ApiError && error.status === 429) retryAfter = error.retryAfterMs ?? 30_000;
          attempt += 1;
        } finally {
          if (watchdog) clearInterval(watchdog);
          stop.signal.removeEventListener("abort", abortConnection);
        }
        if (stop.signal.aborted) break;
        setStatus("down");
        // Rows missed while down arrive by polling now and by replay later.
        await sleep(Math.max(retryAfter ?? 0, backoffMs(attempt - 1)), stop.signal);
      }
    })();

    return () => stop.abort();
  }, [active, client, listKey, streamQs, scope]);

  return { status: active ? status : "off", highlight };
}
