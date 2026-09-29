/**
 * Pure pieces of the live action feed (no React): a server-sent-events
 * parser for fetch streams, the /actions query string, and how stream
 * events merge into the cached /actions lists.
 */
import type { ActionFeedItem } from "@/lib/contracts";

// ---------------------------------------------------------------------------
// Server-sent events (https://html.spec.whatwg.org/multipage/server-sent-events.html)

export interface SseEvent {
  /** `event:` field, "message" when absent. */
  event: string;
  data: string;
  /** `id:` field of this event, when it had one. */
  id?: string;
}

/**
 * Incremental SSE parser: feed decoded text chunks in any split, get the
 * complete events. Handles CRLF/CR/LF line ends (also split across chunks),
 * comments, multi-line data, a leading BOM and `id`/`retry` fields.
 */
export class SseParser {
  /** Last `id:` seen (persists across events, as in EventSource). */
  lastEventId: string | undefined;
  /** Last valid `retry:` (ms). */
  retry: number | undefined;
  private buffer = "";
  private started = false;
  private data: string[] = [];
  private eventType = "";
  private eventId: string | undefined;

  push(chunk: string): SseEvent[] {
    let text = this.buffer + chunk;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    const out: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch !== "\n" && ch !== "\r") continue;
      // A CR at the end of the chunk may be the first half of CRLF.
      if (ch === "\r" && i === text.length - 1) break;
      this.line(text.slice(start, i), out);
      if (ch === "\r" && text[i + 1] === "\n") i++;
      start = i + 1;
    }
    this.buffer = text.slice(start);
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === "") {
      if (this.data.length > 0) {
        out.push({ event: this.eventType || "message", data: this.data.join("\n"), ...(this.eventId !== undefined ? { id: this.eventId } : {}) });
      }
      this.data = [];
      this.eventType = "";
      this.eventId = undefined;
      return;
    }
    if (line.startsWith(":")) return; // comment (heartbeat)
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.eventType = value;
    else if (field === "id") {
      if (!value.includes("\u0000")) {
        this.eventId = value;
        this.lastEventId = value;
      }
    } else if (field === "retry") {
      if (/^\d+$/.test(value)) this.retry = Number(value);
    }
  }
}

/** Reads a fetch body as SSE until it ends; `onChunk` sees every chunk
 * (comments included), for a liveness watchdog. */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
  parser = new SseParser(),
  onChunk?: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk?.();
      for (const event of parser.push(decoder.decode(value, { stream: true }))) onEvent(event);
    }
    for (const event of parser.push(decoder.decode())) onEvent(event);
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// /actions lists

export interface ActionsParams {
  before?: string;
  beforeId?: string;
  scope?: "all" | "favorites";
  address?: string;
  coin?: string;
  kind?: string;
  tier?: string;
  limit?: number;
}

export interface ActionsFilter {
  scope: "all" | "favorites";
  address?: string;
  coin?: string;
  kind?: string;
  tier?: string;
}

/** The GET /actions query string; also the list's React Query key part. */
export function actionsQueryString(params: ActionsParams): string {
  const qs = new URLSearchParams();
  if (params.before) qs.set("before", params.before);
  if (params.beforeId) qs.set("beforeId", params.beforeId);
  if (params.scope && params.scope !== "all") qs.set("scope", params.scope);
  if (params.address) qs.set("address", params.address);
  if (params.coin) qs.set("coin", params.coin);
  if (params.kind) qs.set("kind", params.kind);
  if (params.tier) qs.set("tier", params.tier);
  qs.set("limit", String(params.limit ?? 100));
  return qs.toString();
}

/** The GET /actions/stream query string for the same filters. */
export function streamQueryString(params: ActionsParams): string {
  const qs = new URLSearchParams(actionsQueryString(params));
  for (const key of ["before", "beforeId", "limit"]) qs.delete(key);
  return qs.toString();
}

/** Parses a list's query string back into what it shows. `paged`: an
 * older page (`before`), which live rows never belong to. */
export function parseActionsQuery(qs: string): { filter: ActionsFilter; limit: number; paged: boolean } {
  const p = new URLSearchParams(qs);
  const limit = Number(p.get("limit") ?? 100);
  return {
    filter: {
      scope: p.get("scope") === "favorites" ? "favorites" : "all",
      address: p.get("address") ?? undefined,
      coin: p.get("coin") ?? undefined,
      kind: p.get("kind") ?? undefined,
      tier: p.get("tier") ?? undefined,
    },
    limit: Number.isFinite(limit) && limit > 0 ? limit : 100,
    paged: p.has("before"),
  };
}

/** Whether a row satisfies the filters the page can check itself (not
 * favorites membership). */
export function matchesFilter(item: ActionFeedItem, filter: ActionsFilter): boolean {
  if (filter.address && filter.address.toLowerCase() !== item.address.toLowerCase()) return false;
  if (filter.coin && filter.coin !== item.coin) return false;
  if (filter.kind && filter.kind !== item.kind) return false;
  if (filter.tier && filter.tier !== item.leaderTier) return false;
  return true;
}

const idOf = (item: ActionFeedItem) => BigInt(String(item.id));

/** Feed order: newest `ts` first, then highest id (as GET /actions). */
export function compareActions(a: ActionFeedItem, b: ActionFeedItem): number {
  const dt = Date.parse(b.ts) - Date.parse(a.ts);
  if (dt !== 0) return dt;
  const ia = idOf(a);
  const ib = idOf(b);
  return ib > ia ? 1 : ib < ia ? -1 : 0;
}

/** Upserts `incoming` into `list` by id (incoming wins), in feed order,
 * trimmed to `limit`. */
export function mergeActions(list: readonly ActionFeedItem[], incoming: readonly ActionFeedItem[], limit: number): ActionFeedItem[] {
  const byId = new Map<string, ActionFeedItem>();
  for (const item of list) byId.set(String(item.id), item);
  for (const item of incoming) byId.set(String(item.id), item);
  return [...byId.values()].sort(compareActions).slice(0, limit);
}

export type StreamEventName = "action" | "update";

/**
 * The next contents of one cached first-page list after a stream event, or
 * undefined when it doesn't change.
 * - `action`: a new row joins every list whose filters it satisfies. A
 *   favorites list only takes rows from a favorites stream (the page can't
 *   check favorites itself).
 * - `update` (a corrected row): replaces the row where it is shown, drops it
 *   from lists whose filters it no longer satisfies, and adds it to lists it
 *   now satisfies (same favorites rule).
 */
export function applyStreamEvent(
  list: readonly ActionFeedItem[],
  target: { filter: ActionsFilter; limit: number },
  streamScope: "all" | "favorites",
  event: StreamEventName,
  item: ActionFeedItem,
): ActionFeedItem[] | undefined {
  const id = String(item.id);
  const index = list.findIndex((row) => String(row.id) === id);
  const matches = matchesFilter(item, target.filter);
  const mayAdd = matches && (target.filter.scope === "all" || streamScope === "favorites");
  if (index >= 0) {
    if (!matches) return list.filter((_, i) => i !== index);
    if (event === "action" && JSON.stringify(list[index]) === JSON.stringify(item)) return undefined;
    return mergeActions(list, [item], target.limit);
  }
  if (!mayAdd) return undefined;
  // Older than a full list's last row: it belongs on a later page.
  if (list.length >= target.limit && compareActions(item, list[list.length - 1]) > 0) return undefined;
  return mergeActions(list, [item], target.limit);
}

/**
 * A poll's answer merged with the cached list: rows newer than everything
 * the poll returned arrived over the stream after the server read its
 * snapshot, so they are kept instead of flickering out until the next poll.
 */
export function mergeFetched(fetched: readonly ActionFeedItem[], cached: readonly ActionFeedItem[] | undefined, limit: number): ActionFeedItem[] {
  if (!cached || cached.length === 0) return [...fetched];
  const newest = fetched[0];
  const newer = newest ? cached.filter((row) => compareActions(row, newest) < 0) : [...cached];
  if (newer.length === 0) return [...fetched];
  return mergeActions(fetched, newer, Math.max(limit, fetched.length));
}

/** The highest action id in a list (the resume cursor for a new stream). */
export function newestId(list: readonly ActionFeedItem[] | undefined): string | undefined {
  let best: bigint | undefined;
  for (const row of list ?? []) {
    const id = idOf(row);
    if (best === undefined || id > best) best = id;
  }
  return best === undefined ? undefined : best.toString();
}

/** Reconnect delay: exponential from 1 s to 30 s, with ±20% jitter. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.4 * random()));
}
