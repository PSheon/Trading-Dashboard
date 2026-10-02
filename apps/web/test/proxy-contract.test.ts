import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/hl/[...path]/route";
import { MAX_BODY_BYTES, readBody } from "../src/lib/forward-body";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const context = { params: Promise.resolve({ path: ["actions"] }) };
const req = () => new NextRequest("http://web.test/api/hl/actions", { headers: { "x-api-contract": "1", "x-request-id": "browser_1" } });
it("forwards contract/request metadata and retry hints without adding credentials", async () => {
  vi.stubEnv("NEXT_API_URL", "http://api.test");
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: false }, { status: 429,
    headers: { "x-api-contract": "1", "x-request-id": "browser_1", "retry-after": "30" } }));
  vi.stubGlobal("fetch", fetcher);
  const result = await GET(req(), context);
  const options = fetcher.mock.calls[0][1]!;
  const sent = new Headers(options.headers);
  expect(sent.get("x-api-contract")).toBe("1");
  expect(sent.get("x-request-id")).toBe("browser_1");
  expect(sent.get("authorization")).toBeNull();
  expect(options.redirect).toBe("manual");
  expect(result.status).toBe(429);
  expect(result.headers.get("retry-after")).toBe("30");
});
it("returns a v1 gateway error when an upstream response body breaks", async () => {
  vi.stubEnv("NEXT_API_URL", "http://api.test");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("network")); } }))));
  const result = await GET(req(), context);
  expect(result.status).toBe(502);
  expect(await result.json()).toMatchObject({ success: false, error: { code: "bad_gateway" }, meta: { requestId: "browser_1" } });
});

it("normalizes gateway errors without a negotiation header", async () => {
  vi.stubEnv("NEXT_API_URL", "http://api.test");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unreachable"); }));
  const result = await GET(new NextRequest("http://web.test/api/hl/actions"), context);
  const body = await result.json();
  expect(body).toMatchObject({ success: false, statusCode: 502, error: { code: "bad_gateway" } });
  expect(new Date(body.meta.timestamp).toISOString()).toBe(body.meta.timestamp);
  expect(result.headers.get("x-api-contract")).toBe("1");
  expect(result.headers.get("vary")).toBeNull();
});

it("keeps a cached KOL avatar's caching headers and revalidates it, but never JSON", async () => {
  vi.stubEnv("NEXT_API_URL", "http://api.test");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const fetcher = vi.fn<typeof fetch>(async () => new Response(png, { status: 200, headers: {
    "content-type": "image/png", "cache-control": "public, max-age=2592000, immutable", etag: '"abc"', "x-content-type-options": "nosniff" } }));
  vi.stubGlobal("fetch", fetcher);
  const avatar = { params: Promise.resolve({ path: ["kols", "0x" + "1".repeat(40), "avatar"] }) };
  const result = await GET(new NextRequest("http://web.test/api/hl/kols/x/avatar?v=abc", { headers: { "if-none-match": '"old"' } }), avatar);
  expect(new Headers(fetcher.mock.calls[0][1]!.headers).get("if-none-match")).toBe('"old"');
  expect(result.headers.get("cache-control")).toBe("public, max-age=2592000, immutable");
  expect(result.headers.get("etag")).toBe('"abc"');
  expect(new Uint8Array(await result.arrayBuffer())).toEqual(png);

  fetcher.mockImplementationOnce(async () => Response.json({ success: true }, { headers: { etag: 'W/"j"' } }));
  const json = await GET(new NextRequest("http://web.test/api/hl/actions", { headers: { "if-none-match": 'W/"j"' } }), context);
  expect(new Headers(fetcher.mock.calls[1][1]!.headers).get("if-none-match")).toBeNull();
  expect(json.headers.get("cache-control")).toBe("no-store");
  expect(json.headers.get("etag")).toBeNull();
});

describe("request bodies are bounded (review 31)", () => {
  const post = { params: Promise.resolve({ path: ["me", "favorites"] }) };
  const upstream = () => {
    vi.stubEnv("NEXT_API_URL", "http://api.test");
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: true }, { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  };
  const request = (body: BodyInit, headers: Record<string, string> = {}) =>
    new NextRequest("http://web.test/api/hl/me/favorites", { method: "POST", body, headers: { "content-type": "application/json", ...headers }, duplex: "half" } as never);

  it("a body within the limit is forwarded byte for byte", async () => {
    const fetcher = upstream();
    const payload = JSON.stringify({ note: "x".repeat(MAX_BODY_BYTES - 100) });
    const result = await POST(request(payload), post);
    expect(result.status).toBe(201);
    expect(new TextDecoder().decode(fetcher.mock.calls[0][1]!.body as ArrayBuffer)).toBe(payload);
  });

  it("413 by the declared length, before reading and without calling the api", async () => {
    const fetcher = upstream();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1024)); } });
    const result = await POST(request(body, { "content-length": String(50 * 1024 * 1024) }), post);
    expect(result.status).toBe(413);
    expect(await result.json()).toMatchObject({ success: false, statusCode: 413, error: { code: "payload_too_large" } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("413 while reading when no length is declared (chunked): the stream is cancelled just past the limit, not buffered", async () => {
    const fetcher = upstream();
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { sent += 16 * 1024; controller.enqueue(new Uint8Array(16 * 1024)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const result = await POST(request(body), post);
    expect(result.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThanOrEqual(MAX_BODY_BYTES + 32 * 1024);
  });

  it("a body that stops arriving is given up on (408), not held open", async () => {
    const stalled = new Request("http://web.test/api/hl/me/favorites", { method: "POST", body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(10)); } }), duplex: "half" } as never);
    expect(await readBody(stalled, MAX_BODY_BYTES, 30)).toBe("timeout");
  });
});
