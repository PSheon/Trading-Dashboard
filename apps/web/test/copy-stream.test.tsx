// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WireCopyEvents } from "@trading-dashboard/shared/contracts";

import { describeCopyEvent } from "@/components/copy/copy-feed";
import { shortAgo } from "@/components/copy/activity-panel";

const stream = vi.hoisted(() => ({ calls: [] as Array<string | undefined>, bodies: [] as string[][], failures: [] as Error[] }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  openEventStream: vi.fn(async (_path: string, opts: { lastEventId?: string; signal: AbortSignal }) => {
    stream.calls.push(opts.lastEventId);
    const failure = stream.failures.shift();
    if (failure) throw failure;
    const chunks = stream.bodies.shift() ?? [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        // Keep the connection open until the test aborts it, like a live stream.
        opts.signal.addEventListener("abort", () => controller.close(), { once: true });
        if (!chunks.length) controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }),
}));

import { applyCopyEvent, useCopyStream, type CopyFeedEvent } from "@/lib/use-copy-stream";
import { copyStreamStatus } from "@/lib/copy";

const frame = (e: CopyFeedEvent) => `event: copy\nid: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`;
const ev = (id: number, type = "order_filled", payload: Record<string, unknown> = { mode: "paper", coin: "BTC", side: "B", action: "open", px: "100" }): CopyFeedEvent =>
  ({ id: String(id), strategyId: 1, type, payload, createdAt: new Date(Date.UTC(2026, 9, 4, 0, id)).toISOString() });

describe("what a copy event says (activity rows and toasts)", () => {
  it("classifies fills by what they did to the position, with the copy's side and PnL after fees", () => {
    expect(describeCopyEvent(ev(1))).toMatchObject({ kind: "open", coin: "BTC", long: true, px: 100, pnl: null });
    expect(describeCopyEvent(ev(2, "order_filled", { mode: "paper", coin: "ETH", side: "A", action: "increase", px: "4000" }))).toMatchObject({ kind: "increase", long: false });
    // Selling a long down: a reduction of the long, PnL after fees.
    expect(describeCopyEvent(ev(3, "order_filled", { mode: "paper", coin: "BTC", side: "A", action: "decrease", px: "110", realizedPnl: "10", fee: "0.5" }))).toMatchObject({ kind: "decrease", long: true, pnl: 9.5 });
    expect(describeCopyEvent(ev(4, "order_filled", { mode: "paper", coin: "BTC", side: "B", action: "close", px: "90", realizedPnl: "-4", fee: "1" }))).toMatchObject({ kind: "close", long: false, pnl: -5 });
    expect(describeCopyEvent(ev(5, "position_liquidated", { mode: "paper", coin: "SOL", side: "A", realizedPnl: "-50", fee: "0" }))).toMatchObject({ kind: "liquidation", long: true, pnl: -50 });
    // Older events (no action field) still read by leg.
    expect(describeCopyEvent(ev(6, "order_filled", { mode: "paper", coin: "BTC", side: "A", leg: "close" }))).toMatchObject({ kind: "decrease", long: true });
    expect(describeCopyEvent(ev(7, "funds_added", { mode: "paper", amount: "250" }))).toMatchObject({ kind: "funds_in", amount: 250 });
    expect(describeCopyEvent(ev(8, "funds_withdrawn", { mode: "paper", amount: "40" }))).toMatchObject({ kind: "funds_out", amount: 40 });
    expect(describeCopyEvent(ev(9, "funds_returned", { mode: "paper", amount: "990" }))).toMatchObject({ kind: "sweep", amount: 990 });
    expect(describeCopyEvent(ev(10, "wallet_withdrawal", { mode: "hub", amount: "12.5", status: "accepted" }))).toMatchObject({ kind: "hub_withdrawal", amount: 12.5 });
    expect(describeCopyEvent(ev(11, "strategy_command", { mode: "paper", command: "pause" })).kind).toBe("other");
  });

  it("short times as CopyDog's activity panel shows them", () => {
    const now = Date.UTC(2026, 9, 4, 12);
    const t = () => "Just now";
    expect(shortAgo(now - 30_000, t, now)).toBe("Just now");
    expect(shortAgo(now - 5 * 60_000, t, now)).toBe("5m");
    expect(shortAgo(now - 3 * 3_600_000, t, now)).toBe("3h");
    expect(shortAgo(now - 2 * 86_400_000, t, now)).toBe("2d");
  });

  it("merging a pushed event is idempotent and keeps id order", () => {
    const base: WireCopyEvents = { items: [ev(1), ev(2)], nextCursor: "2", previousCursor: "1", hasMore: false };
    const once = applyCopyEvent(base, ev(3));
    const twice = applyCopyEvent(once, ev(3));
    expect(twice.items.map((e) => e.id)).toEqual(["1", "2", "3"]);
    expect(twice.nextCursor).toBe("3");
    expect(applyCopyEvent(twice, ev(2)).nextCursor).toBe("3");
  });
});

describe("useCopyStream", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const key = ["copy", "events", "signedIn", "live", "a@b.c", "s"] as const;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    stream.calls.length = 0;
    stream.bodies.length = 0;
    stream.failures.length = 0;
    client = new QueryClient();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  function Probe({ onEvent }: { onEvent: (e: CopyFeedEvent) => void }) {
    useCopyStream({ enabled: true, eventsKey: key, onEvent });
    return null;
  }

  it("resumes from the loaded list's cursor, merges pushed events once, hands each new one over once, and refreshes the portfolio reads", async () => {
    client.setQueryData<WireCopyEvents>(key, { items: [ev(1), ev(2)], nextCursor: "2", previousCursor: "1", hasMore: false });
    client.setQueryData(["copy", "overview"], { stale: false });
    // The replay repeats event 2 (already listed), then 3 and 4 arrive.
    stream.bodies.push([": ok\n\n", frame(ev(2)), frame(ev(3)), frame(ev(4, "position_liquidated", { mode: "paper", coin: "ETH", side: "A" }))]);
    const seen: string[] = [];
    await act(async () => { root.render(<QueryClientProvider client={client}><Probe onEvent={(e) => seen.push(e.id)} /></QueryClientProvider>); });
    await vi.waitFor(() => expect(client.getQueryData<WireCopyEvents>(key)?.items.map((e) => e.id)).toEqual(["1", "2", "3", "4"]));
    expect(stream.calls[0]).toBe("2");
    expect(seen).toEqual(["3", "4"]);
    expect(copyStreamStatus.get()).toBe("live");
    await vi.waitFor(() => expect(client.getQueryState(["copy", "overview"])?.isInvalidated).toBe(true), { timeout: 2000 });
    // The events list itself is never invalidated by a push.
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  });

  it("does not create the list when no page has loaded it (the page loads the latest itself), but still hands the event over", async () => {
    stream.bodies.push([frame(ev(9))]);
    const seen: string[] = [];
    await act(async () => { root.render(<QueryClientProvider client={client}><Probe onEvent={(e) => seen.push(e.id)} /></QueryClientProvider>); });
    await vi.waitFor(() => expect(seen).toEqual(["9"]));
    expect(stream.calls[0]).toBeUndefined();
    expect(client.getQueryData(key)).toBeUndefined();
  });

  it("a busy 503 waits for its Retry-After before connecting again (web audit L4)", async () => {
    const { ApiError } = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stream.failures.push(new ApiError(503, "busy", { code: "busy" }, 40_000));
      await act(async () => { root.render(<QueryClientProvider client={client}><Probe onEvent={() => undefined} /></QueryClientProvider>); });
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(stream.calls).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(21_000); });
      expect(stream.calls).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it("a reset drops the stale list so it reloads", async () => {
    client.setQueryData<WireCopyEvents>(key, { items: [ev(1)], nextCursor: "1", previousCursor: "1", hasMore: false });
    stream.bodies.push([`event: reset\ndata: {"reason":"replay_truncated"}\n\n`]);
    await act(async () => { root.render(<QueryClientProvider client={client}><Probe onEvent={() => undefined} /></QueryClientProvider>); });
    await vi.waitFor(() => expect(client.getQueryData(key)).toBeUndefined());
  });
});
