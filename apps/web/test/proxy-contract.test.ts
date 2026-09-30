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
