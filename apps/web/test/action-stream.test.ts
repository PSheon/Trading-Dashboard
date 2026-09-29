import { describe, expect, it } from "vitest";
import type { ActionFeedItem } from "../src/lib/contracts";
import {
  actionsQueryString,
  applyStreamEvent,
  backoffMs,
  mergeActions,
  mergeFetched,
  newestId,
  parseActionsQuery,
  readSseStream,
  SseParser,
  streamQueryString,
  type SseEvent,
} from "../src/lib/action-stream";

const WHALE = "0x" + "aa".repeat(20);
const OTHER = "0x" + "bb".repeat(20);
const row = (id: number | string, ts: string, over: Partial<ActionFeedItem> = {}): ActionFeedItem => ({
  id: String(id), chain: "hyperliquid", address: WHALE, coin: "BTC", kind: "open", side: "long",
  notionalUsd: "1000", avgPx: "65000", leverage: "10", fillIds: [], ts, leaderLabel: null, leaderTier: "A", ...over,
});
const ids = (list: readonly ActionFeedItem[] | undefined) => list?.map((r) => r.id);

describe("SseParser", () => {
  it("parses events split at any byte, with comments, ids and multi-line data", () => {
    const text = ": ok\nretry: 3000\n\nevent: action\nid: 7\ndata: {\"a\":1}\n\n: hb\n\nevent: update\ndata: line1\ndata: line2\n\n";
    for (let size = 1; size <= text.length; size++) {
      const parser = new SseParser();
      const out: SseEvent[] = [];
      for (let i = 0; i < text.length; i += size) out.push(...parser.push(text.slice(i, i + size)));
      expect(out).toEqual([
        { event: "action", id: "7", data: "{\"a\":1}" },
        { event: "update", data: "line1\nline2" },
      ]);
      expect(parser.lastEventId).toBe("7"); // an update carries no id: the cursor stays
      expect(parser.retry).toBe(3000);
    }
  });

  it("accepts CRLF and lone CR line ends, even split between chunks, and a BOM", () => {
    const parser = new SseParser();
    const out = [
      ...parser.push("﻿data: a\r"),
      ...parser.push("\n\r\ndata: b\r"),
      ...parser.push("\rdata:c\n\n"),
    ];
    expect(out).toEqual([{ event: "message", data: "a" }, { event: "message", data: "b" }, { event: "message", data: "c" }]);
  });

  it("ignores events without data, unknown fields, ids with NUL and bad retry values", () => {
    const parser = new SseParser();
    expect(parser.push("event: reset\n\nfoo: bar\nid: 1\u00002\nretry: soon\ndata\n\n")).toEqual([{ event: "message", data: "" }]);
    expect(parser.lastEventId).toBeUndefined();
    expect(parser.retry).toBeUndefined();
  });

  it("reads a byte stream, including multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("event: action\nid: 1\ndata: \"強平\"\n\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const b of bytes) controller.enqueue(new Uint8Array([b]));
        controller.close();
      },
    });
    const events: SseEvent[] = [];
    let chunks = 0;
    await readSseStream(body, (e) => events.push(e), undefined, () => chunks++);
    expect(events).toEqual([{ event: "action", id: "1", data: "\"強平\"" }]);
    expect(chunks).toBe(bytes.length);
  });
});

describe("query strings", () => {
  it("builds the list key and the matching stream query", () => {
    const qs = actionsQueryString({ scope: "favorites", coin: "BTC", kind: "open", limit: 50 });
    expect(qs).toBe("scope=favorites&coin=BTC&kind=open&limit=50");
    expect(streamQueryString({ scope: "favorites", coin: "BTC", kind: "open", limit: 50, before: "x" })).toBe("scope=favorites&coin=BTC&kind=open");
    expect(streamQueryString({})).toBe("");
    expect(parseActionsQuery(qs)).toEqual({ filter: { scope: "favorites", coin: "BTC", kind: "open", address: undefined, tier: undefined }, limit: 50, paged: false });
    expect(parseActionsQuery("before=2026-01-01&limit=20").paged).toBe(true);
  });
});

describe("merging stream events into cached lists", () => {
  const list = [row(3, "2026-01-01T00:00:03Z"), row(2, "2026-01-01T00:00:02Z"), row(1, "2026-01-01T00:00:01Z")];
  const all = { filter: { scope: "all" as const }, limit: 100 };

  it("inserts a new row in feed order and dedupes by id", () => {
    const next = applyStreamEvent(list, all, "all", "action", row(4, "2026-01-01T00:00:04Z"));
    expect(ids(next)).toEqual(["4", "3", "2", "1"]);
    // Same row again (a replay after reconnect, or a poll already had it).
    expect(applyStreamEvent(next!, all, "all", "action", row(4, "2026-01-01T00:00:04Z"))).toBeUndefined();
    // Out of order arrival: sorted by ts, then id.
    expect(ids(applyStreamEvent(list, all, "all", "action", row(9, "2026-01-01T00:00:02Z")))).toEqual(["3", "9", "2", "1"]);
    expect(ids(mergeActions(list, [row(2, "2026-01-01T00:00:02Z", { side: "short" }), row(2, "2026-01-01T00:00:02Z")], 2))).toEqual(["3", "2"]);
  });

  it("respects the list's own filters, its limit and the favorites rule", () => {
    expect(applyStreamEvent(list, { filter: { scope: "all", coin: "ETH" }, limit: 100 }, "all", "action", row(4, "2026-01-01T00:00:04Z"))).toBeUndefined();
    expect(applyStreamEvent(list, { filter: { scope: "all", address: WHALE.toUpperCase() }, limit: 100 }, "all", "action", row(4, "2026-01-01T00:00:04Z", { address: OTHER }))).toBeUndefined();
    expect(applyStreamEvent(list, { filter: { scope: "all", tier: "B" }, limit: 100 }, "all", "action", row(4, "2026-01-01T00:00:04Z"))).toBeUndefined();
    // Full list: a row older than its last one belongs on a later page.
    expect(applyStreamEvent(list, { filter: { scope: "all" }, limit: 3 }, "all", "action", row(0, "2026-01-01T00:00:00Z"))).toBeUndefined();
    expect(ids(applyStreamEvent(list, { filter: { scope: "all" }, limit: 3 }, "all", "action", row(4, "2026-01-01T00:00:04Z")))).toEqual(["4", "3", "2"]);
    // A favorites list takes rows only from a favorites stream.
    const favorites = { filter: { scope: "favorites" as const }, limit: 100 };
    expect(applyStreamEvent(list, favorites, "all", "action", row(4, "2026-01-01T00:00:04Z"))).toBeUndefined();
    expect(ids(applyStreamEvent(list, favorites, "favorites", "action", row(4, "2026-01-01T00:00:04Z")))).toEqual(["4", "3", "2", "1"]);
    // …while a favorites stream's rows are fine for an unscoped list.
    expect(ids(applyStreamEvent(list, all, "favorites", "action", row(4, "2026-01-01T00:00:04Z")))).toEqual(["4", "3", "2", "1"]);
  });

  it("applies a correction in place, and moves the row between kind-filtered lists", () => {
    const fixed = row(2, "2026-01-01T00:00:02Z", { kind: "liquidation", side: "long" });
    const updated = applyStreamEvent(list, all, "all", "update", fixed);
    expect(updated?.[1]).toEqual(fixed);
    expect(ids(updated)).toEqual(["3", "2", "1"]);
    const opens = { filter: { scope: "all" as const, kind: "open" }, limit: 100 };
    expect(ids(applyStreamEvent(list, opens, "all", "update", fixed))).toEqual(["3", "1"]);
    const liquidations = { filter: { scope: "all" as const, kind: "liquidation" }, limit: 100 };
    expect(ids(applyStreamEvent([], liquidations, "all", "update", fixed))).toEqual(["2"]);
    // A favorites list doesn't take in rows it may not show, but fixes its own.
    const favorites = { filter: { scope: "favorites" as const }, limit: 100 };
    expect(applyStreamEvent([], favorites, "all", "update", fixed)).toBeUndefined();
    expect(applyStreamEvent(list, favorites, "all", "update", fixed)?.[1]).toEqual(fixed);
  });

  it("keeps streamed rows newer than a poll's snapshot", () => {
    const cached = [row(5, "2026-01-01T00:00:05Z"), ...list];
    const polled = [row(4, "2026-01-01T00:00:04Z"), ...list];
    expect(ids(mergeFetched(polled, cached, 100))).toEqual(["5", "4", "3", "2", "1"]);
    // The poll wins for rows it has (a correction it knows of).
    const corrected = [row(3, "2026-01-01T00:00:03Z", { kind: "close" }), ...list.slice(1)];
    expect(mergeFetched(corrected, list, 100)[0].kind).toBe("close");
    expect(ids(mergeFetched(list, undefined, 100))).toEqual(["3", "2", "1"]);
    expect(ids(mergeFetched([], cached, 100))).toEqual(["5", "3", "2", "1"]);
  });

  it("finds the resume cursor and backs off within bounds", () => {
    expect(newestId([row(10, "2026-01-01T00:00:01Z"), row("9007199254740993", "2026-01-01T00:00:00Z")])).toBe("9007199254740993");
    expect(newestId(undefined)).toBeUndefined();
    expect(backoffMs(0, () => 0.5)).toBe(1000);
    expect(backoffMs(3, () => 0.5)).toBe(8000);
    expect(backoffMs(20, () => 1)).toBe(36_000);
    expect(backoffMs(20, () => 0)).toBe(24_000);
  });
});

describe("applyToCaches (React Query)", () => {
  it("merges a stream event into every matching first-page /actions list, once", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { applyToCaches } = await import("../src/lib/use-action-stream");
    const client = new QueryClient();
    const base = [row(1, "2026-01-01T00:00:01Z")];
    client.setQueryData(["actions", "limit=100"], base);
    client.setQueryData(["actions", "coin=ETH&limit=100"], []);
    client.setQueryData(["actions", "before=2026-01-01T00%3A00%3A00Z&limit=100"], base);
    client.setQueryData(["actions", "scope=favorites&limit=50"], base);
    client.setQueryData(["trader-fills", "x"], ["untouched"]);

    const fresh = row(2, "2026-01-01T00:00:02Z");
    expect(applyToCaches(client, "limit=100", "all", "action", fresh)).toBe(true);
    expect(applyToCaches(client, "limit=100", "all", "action", fresh)).toBe(false); // duplicate
    expect(ids(client.getQueryData(["actions", "limit=100"]))).toEqual(["2", "1"]);
    expect(client.getQueryData(["actions", "coin=ETH&limit=100"])).toEqual([]);
    expect(ids(client.getQueryData(["actions", "before=2026-01-01T00%3A00%3A00Z&limit=100"]))).toEqual(["1"]);
    expect(ids(client.getQueryData(["actions", "scope=favorites&limit=50"]))).toEqual(["1"]);
    expect(client.getQueryData(["trader-fills", "x"])).toEqual(["untouched"]);

    applyToCaches(client, "limit=100", "all", "update", { ...fresh, kind: "close" });
    expect(client.getQueryData<ActionFeedItem[]>(["actions", "limit=100"])?.[0].kind).toBe("close");
  });
});
