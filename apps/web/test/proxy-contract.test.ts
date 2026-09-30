import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../src/app/api/hl/[...path]/route";

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
