import { describe, expect, it, vi } from "vitest";

import { fixtureRequest } from "../src/fixtures/handler";
import { prefetchPublic } from "../src/lib/server-prefetch";

const apiUrl = "http://api:3100";
const envelope = (data: unknown, statusCode = 200) => ({ success: true, statusCode, message: "OK", data, meta: { requestId: "r", path: "/x", timestamp: new Date().toISOString() } });
const answer = (body: unknown, status = 200) => vi.fn(async () => Response.json(body, { status })) as unknown as typeof fetch;

describe("prefetchPublic: the home rows read while the page renders on the server", () => {
  it("returns contract-valid data with its read time, counted against the visitor", async () => {
    const home = JSON.parse(JSON.stringify(await fixtureRequest("GET", "/discover/home", undefined, null)));
    const fetchImpl = answer(envelope(home));
    const before = Date.now();
    const read = await prefetchPublic("/discover/home", { apiUrl, fetchImpl, client: "203.0.113.9" });
    expect(read?.data).toEqual(home);
    expect(read!.fetchedAt).toBeGreaterThanOrEqual(before);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe("http://api:3100/discover/home");
    expect(init.headers).toMatchObject({ "x-api-contract": "1", "X-Forwarded-For": "203.0.113.9" });
    expect(init.cache).toBe("no-store");
  });

  it("falls back (null) to the browser's own fetch on any failure instead of guessing", async () => {
    expect(await prefetchPublic("/discover/home", { apiUrl: undefined })).toBeNull();
    expect(await prefetchPublic("/discover/home", { apiUrl, fetchImpl: answer({ success: false }, 503) })).toBeNull();
    expect(await prefetchPublic("/discover/home", { apiUrl, fetchImpl: answer(envelope({ featured: "not rows" })) })).toBeNull();
    expect(await prefetchPublic("/discover/home", { apiUrl, fetchImpl: answer(envelope({}, 201)) })).toBeNull();
    const hang = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    expect(await prefetchPublic("/discover/home", { apiUrl, fetchImpl: hang, timeoutMs: 20 })).toBeNull();
    // Only documented routes; never a path outside the api's base.
    expect(await prefetchPublic("/not-a-route", { apiUrl, fetchImpl: answer(envelope({})) })).toBeNull();
    expect(await prefetchPublic("//evil.test/discover/home", { apiUrl, fetchImpl: answer(envelope({})) })).toBeNull();
  });
});
