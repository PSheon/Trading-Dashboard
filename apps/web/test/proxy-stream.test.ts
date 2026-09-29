import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../src/app/api/hl/[...path]/route";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const context = { params: Promise.resolve({ path: ["actions", "stream"] }) };
const encoder = new TextEncoder();

/** An upstream SSE response the test writes to chunk by chunk. */
function upstreamStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    cancel() { cancelled = true; },
  });
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "x-request-id": "r1" } }),
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    get cancelled() { return cancelled; },
  };
}

function browserRequest(init: { signal?: AbortSignal; headers?: Record<string, string> } = {}) {
  return new NextRequest("http://web.test/api/hl/actions/stream?coin=BTC", {
    signal: init.signal,
    headers: {
      accept: "text/event-stream",
      authorization: "Bearer privy-token",
      "last-event-id": "42",
      "x-forwarded-for": "6.6.6.6, 203.0.113.9",
      ...init.headers,
    },
  });
}

it("relays text/event-stream chunk by chunk, without buffering or the upstream deadline", async () => {
  vi.stubEnv("NEXT_API_URL", "http://api.test");
  vi.stubEnv("AUTH_SERVICE_TOKEN", "service-secret-never-forwarded");
  const upstream = upstreamStream();
  const fetcher = vi.fn<typeof fetch>(async () => upstream.response);
  vi.stubGlobal("fetch", fetcher);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  const result = await GET(browserRequest(), context);
  const [url, options] = fetcher.mock.calls[0];
  expect(String(url)).toBe("http://api.test/actions/stream?coin=BTC");
  const sent = new Headers(options!.headers);
  expect(sent.get("authorization")).toBe("Bearer privy-token"); // the browser's own, untouched
  expect([...sent.values()].join(" ")).not.toContain("service-secret");
  expect(sent.get("last-event-id")).toBe("42");
  expect(sent.get("accept")).toBe("text/event-stream");
  expect(sent.get("x-forwarded-for")).toBe("203.0.113.9"); // only the platform-written entry
  expect(options!.redirect).toBe("manual");

  expect(result.status).toBe(200);
  expect(result.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(result.headers.get("cache-control")).toBe("no-cache, no-transform");
  expect(result.headers.get("x-accel-buffering")).toBe("no");

  const reader = result.body!.getReader();
  const decoder = new TextDecoder();
  upstream.send(": ok\n\n");
  expect(decoder.decode((await reader.read()).value)).toBe(": ok\n\n");
  // Way past the 20 s deadline of buffered calls: still open.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(options!.signal!.aborted).toBe(false);
  upstream.send("event: action\nid: 43\ndata: {}\n\n");
  expect(decoder.decode((await reader.read()).value)).toBe("event: action\nid: 43\ndata: {}\n\n");
  upstream.end();
  expect((await reader.read()).done).toBe(true);
});

it("aborts the upstream stream when the browser disconnects", async () => {
  vi.stubEnv("NEXT_API_URL", "http://api.test");
  const upstream = upstreamStream();
  const fetcher = vi.fn<typeof fetch>(async () => upstream.response);
  vi.stubGlobal("fetch", fetcher);
  const browser = new AbortController();
  const result = await GET(browserRequest({ signal: browser.signal }), context);
  const signal = fetcher.mock.calls[0][1]!.signal!;
  upstream.send(": ok\n\n");
  const reader = result.body!.getReader();
  await reader.read();

  browser.abort();
  expect(signal.aborted).toBe(true);
});

it("cancels the upstream stream when the response is cancelled", async () => {
  vi.stubEnv("NEXT_API_URL", "http://api.test");
  const upstream = upstreamStream();
  const fetcher = vi.fn<typeof fetch>(async () => upstream.response);
  vi.stubGlobal("fetch", fetcher);
  const result = await GET(browserRequest(), context);
  await result.body!.cancel("client went away");
  expect(fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
  expect(upstream.cancelled).toBe(true);
});

it("ends the relay (no exception) when the upstream breaks mid-stream", async () => {
  vi.stubEnv("NEXT_API_URL", "http://api.test");
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } })));
  const result = await GET(browserRequest(), context);
  const reader = result.body!.getReader();
  controller.enqueue(encoder.encode(": ok\n\n"));
  await reader.read();
  controller.error(new Error("socket hang up"));
  expect((await reader.read()).done).toBe(true);
});

it("passes a refusal through as JSON and drops a malformed Last-Event-ID", async () => {
  vi.stubEnv("NEXT_API_URL", "http://api.test");
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ statusCode: 429, message: "Too many open streams", code: "rate_limited" },
    { status: 429, headers: { "retry-after": "30" } }));
  vi.stubGlobal("fetch", fetcher);
  const result = await GET(browserRequest({ headers: { "last-event-id": "1; drop table", "x-forwarded-for": "not-an-ip" } }), context);
  const sent = new Headers(fetcher.mock.calls[0][1]!.headers);
  expect(sent.get("last-event-id")).toBeNull();
  expect(sent.get("x-forwarded-for")).toBeNull();
  expect(result.status).toBe(429);
  expect(result.headers.get("retry-after")).toBe("30");
  expect(await result.json()).toMatchObject({ code: "rate_limited" });
});

it("still refuses to relay a redirect for a stream request", async () => {
  vi.stubEnv("NEXT_API_URL", "http://api.test");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://evil.test/" } })));
  const result = await GET(browserRequest(), context);
  expect(result.status).toBe(502);
});
