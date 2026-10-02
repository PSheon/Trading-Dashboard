import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET as forward } from "../src/app/api/hl/[...path]/route";
import { GET as shareImage } from "../src/app/trader/[address]/share-image/route";
import { IMAGES_PER_MINUTE, clientAddress, clientBucket, imageRetryAfter, resetImageLimiter } from "../src/lib/client-address";
import { loadShareCard, loadTraderName } from "../src/lib/share-card-data";

const ADDRESS = `0x${"ab".repeat(20)}`;
const h = (init: Record<string, string>) => new Headers(init);

beforeEach(() => resetImageLimiter());
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("the caller's address, as the platform in front of the web server reports it (review 28)", () => {
  it("by default: the last X-Forwarded-For entry, never one the client put further left", () => {
    expect(clientAddress(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), undefined)).toBe("203.0.113.9");
    expect(clientAddress(h({ "x-forwarded-for": "2001:db8::7" }), undefined)).toBe("2001:db8::7");
    expect(clientAddress(h({ "x-forwarded-for": "not-an-ip" }), undefined)).toBeUndefined();
    expect(clientAddress(h({ "x-real-ip": "203.0.113.9" }), undefined)).toBeUndefined();
  });

  it("CLIENT_IP_HEADER=x-real-ip (Railway's edge): that header, and X-Forwarded-For is ignored", () => {
    const headers = h({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6" });
    expect(clientAddress(headers, "x-real-ip")).toBe("203.0.113.9");
    expect(clientAddress(headers, " X-Real-IP ")).toBe("203.0.113.9");
    expect(clientAddress(h({ "x-forwarded-for": "6.6.6.6" }), "x-real-ip")).toBeUndefined();
  });

  it("the /api/hl forwarder sends exactly that address as X-Forwarded-For, replacing whatever the client sent", async () => {
    vi.stubEnv("NEXT_API_URL", "http://api.test");
    vi.stubEnv("CLIENT_IP_HEADER", "x-real-ip");
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetcher);
    const request = new NextRequest("http://web.test/api/hl/actions", { headers: { "x-real-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6, 7.7.7.7" } });
    await forward(request, { params: Promise.resolve({ path: ["actions"] }) });
    expect(new Headers(fetcher.mock.calls[0][1]!.headers).get("x-forwarded-for")).toBe("203.0.113.9");

    // No address from the edge: no header at all (the api then counts this server).
    await forward(new NextRequest("http://web.test/api/hl/actions", { headers: { "x-forwarded-for": "6.6.6.6" } }), { params: Promise.resolve({ path: ["actions"] }) });
    expect(new Headers(fetcher.mock.calls[1][1]!.headers).get("x-forwarded-for")).toBeNull();
  });

  it("counts IPv4 per address and IPv6 per /64, like the api", () => {
    expect(clientBucket("203.0.113.9")).toBe("203.0.113.9");
    expect(clientBucket("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(clientBucket("2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(clientBucket("2001:db8::9")).toBe("2001:db8:0:0::/64");
    expect(clientBucket(undefined)).toBe("unknown");
  });
});

describe("share and link-preview images act for the caller (review 28)", () => {
  it("the card's api reads carry the caller's address", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: null }));
    await loadShareCard(ADDRESS, "month", { apiUrl: "http://api.test", fetchImpl, client: "203.0.113.9" });
    await loadTraderName(ADDRESS, { apiUrl: "http://api.test", fetchImpl, client: "203.0.113.9" });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    for (const [, init] of fetchImpl.mock.calls) expect(new Headers(init!.headers).get("x-forwarded-for")).toBe("203.0.113.9");

    fetchImpl.mockClear();
    await loadShareCard(ADDRESS, "allTime", { apiUrl: "http://api.test", fetchImpl });
    for (const [, init] of fetchImpl.mock.calls) expect(new Headers(init!.headers).get("x-forwarded-for")).toBeNull();
  });

  it("one client gets 30 images a minute, then 429 with Retry-After; another client is not affected", () => {
    const now = 1_000_000;
    for (let i = 0; i < IMAGES_PER_MINUTE; i++) expect(imageRetryAfter("203.0.113.9", now + i)).toBe(0);
    expect(imageRetryAfter("203.0.113.9", now + 100)).toBe(60);
    expect(imageRetryAfter("203.0.113.10", now + 100)).toBe(0);
    // Addresses inside one IPv6 /64 are one client.
    for (let i = 0; i < IMAGES_PER_MINUTE; i++) expect(imageRetryAfter(`2001:db8:1:2::${i + 1}`, now)).toBe(0);
    expect(imageRetryAfter("2001:db8:1:2:ffff::1", now)).toBeGreaterThan(0);
    expect(imageRetryAfter("203.0.113.9", now + 60_001)).toBe(0);
  });

  it("the share-image route refuses the 31st card without calling the api", async () => {
    vi.stubEnv("NEXT_API_URL", "http://api.test");
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: null }));
    vi.stubGlobal("fetch", fetcher);
    for (let i = 0; i < IMAGES_PER_MINUTE; i++) imageRetryAfter("203.0.113.9");
    const request = new NextRequest(`http://web.test/trader/${ADDRESS}/share-image?period=allTime`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    const result = await shareImage(request, { params: Promise.resolve({ address: ADDRESS }) });
    expect(result.status).toBe(429);
    expect(Number(result.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
