import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TraderView } from "@/components/trader/trader-view";
import { fixtureRequest } from "@/fixtures/handler";
import { UNKNOWN_ADDRESS } from "@/fixtures/data";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import { truncateAddress } from "@/lib/format";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {} }),
  usePathname: () => "/trader",
  notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); },
}));
const prefetch = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/server-prefetch", async (original) => ({ ...(await original<typeof import("@/lib/server-prefetch")>()), prefetchTrader: (...args: unknown[]) => prefetch.read(...args) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }) }));

const apiUrl = "http://api:3100";
const KNOWN = `0x${"ab".repeat(20)}`;
const envelope = (data: unknown) => ({ success: true, statusCode: 200, message: "OK", data, meta: { requestId: "r", path: "/x", timestamp: new Date().toISOString() } });
/** apps/api answered by the fixture handler, as the browser would see it. */
const fixtureApi = (delayMs = 0) => vi.fn(async (url: URL | string, init?: RequestInit) => {
  if (delayMs) await new Promise((resolve, reject) => { const t = setTimeout(resolve, delayMs); init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(init.signal!.reason); }); });
  const path = new URL(String(url)).pathname;
  return Response.json(envelope(JSON.parse(JSON.stringify(await fixtureRequest("GET", path, undefined, null)))));
}) as unknown as typeof fetch;

const render = (address: string, initial?: Parameters<typeof TraderView>[0]["initial"]) => renderToString(
  <QueryClientProvider client={new QueryClient()}>
    <I18nProvider locale="en" messages={en}><TraderView address={address} initial={initial} /></I18nProvider>
  </QueryClientProvider>,
);

afterEach(() => prefetch.read.mockReset());

describe("prefetchTrader: the trader page's server read", () => {
  it("reads only the profile for a known address: the activity's fill lists are not first paint (Stage, 2026-10-05)", async () => {
    const fetchImpl = fixtureApi();
    const read = await (await vi.importActual<typeof import("@/lib/server-prefetch")>("@/lib/server-prefetch")).prefetchTrader(KNOWN.toUpperCase().replace("0X", "0x"), { apiUrl, fetchImpl, client: "203.0.113.9" });
    expect(read.unknown).toBe(false);
    expect(read.profile?.data.address.toLowerCase()).toBe(KNOWN);
    expect(read.activity).toBeNull();
    const urls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => String(url)).sort();
    expect(urls).toEqual([`${apiUrl}/traders/${KNOWN}`]);
  });

  it("reads the activity after a blank profile, the only case it decides", async () => {
    const fetchImpl = fixtureApi();
    const read = await (await vi.importActual<typeof import("@/lib/server-prefetch")>("@/lib/server-prefetch")).prefetchTrader(UNKNOWN_ADDRESS, { apiUrl, fetchImpl });
    const urls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([`${apiUrl}/traders/${UNKNOWN_ADDRESS.toLowerCase()}`, `${apiUrl}/traders/${UNKNOWN_ADDRESS.toLowerCase()}/activity`]);
    expect(read.activity?.data).toBeTruthy();
  });

  it("calls an address with nothing on Hyperliquid unknown, and a slow api not known", async () => {
    const actual = await vi.importActual<typeof import("@/lib/server-prefetch")>("@/lib/server-prefetch");
    expect((await actual.prefetchTrader(UNKNOWN_ADDRESS, { apiUrl, fetchImpl: fixtureApi() })).unknown).toBe(true);
    const slow = await actual.prefetchTrader(UNKNOWN_ADDRESS, { apiUrl, fetchImpl: fixtureApi(200), timeoutMs: 20 });
    expect(slow).toEqual({ profile: null, activity: null, unknown: null });
  });
});

describe("the trader page on the server", () => {
  it("answers a real 404 for an address Hyperliquid has nothing for, before anything is sent", async () => {
    const { default: TraderPage } = await import("@/app/[locale]/trader/[address]/page");
    prefetch.read.mockResolvedValue({ profile: null, activity: null, unknown: true });
    await expect(TraderPage({ params: Promise.resolve({ address: UNKNOWN_ADDRESS }) } as never)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(prefetch.read).toHaveBeenCalledWith(UNKNOWN_ADDRESS, { client: "203.0.113.9" });
  });

  it("hands what it read to the page, and renders without it when the api was slow", async () => {
    const { default: TraderPage } = await import("@/app/[locale]/trader/[address]/page");
    const read = { profile: { data: { address: KNOWN }, fetchedAt: 1 }, activity: null, unknown: false };
    prefetch.read.mockResolvedValue(read);
    const element = (await TraderPage({ params: Promise.resolve({ address: KNOWN }) } as never)) as { props: { initial: unknown } };
    expect(element.props.initial).toEqual({ profile: read.profile, activity: null });
    prefetch.read.mockResolvedValue({ profile: null, activity: null, unknown: null });
    const fallback = (await TraderPage({ params: Promise.resolve({ address: KNOWN }) } as never)) as { props: { initial: unknown } };
    expect(fallback.props.initial).toEqual({ profile: null, activity: null });
  });

  it("puts the h1, the name and the profile's figures in the first HTML when the profile was read", async () => {
    const profile = JSON.parse(JSON.stringify(await fixtureRequest("GET", `/traders/${KNOWN}`, undefined, null)));
    const activity = JSON.parse(JSON.stringify(await fixtureRequest("GET", `/traders/${KNOWN}/activity`, undefined, null)));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const html = render(KNOWN, { profile: { data: profile, fetchedAt: Date.now() }, activity: { data: activity, fetchedAt: Date.now() } });
    expect(html).toMatch(/<h1 id="trader-name"/);
    expect(html).toContain(profile.displayName ?? truncateAddress(KNOWN));
    expect(html).toContain(truncateAddress(KNOWN));
    expect(html).toContain(en.trader.leverage);
    // The trade sections are still loading, not failed.
    expect(html).not.toContain(en.trader.analyticsFailed);
    // Without the server's read: the loading outline only, as before.
    expect(render(KNOWN)).not.toContain('id="trader-name"');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("the server's anonymous read for a signed-in visitor", () => {
  it("is shown but asked again: stale for a known user, refetched after sign-in while the provider loads", async () => {
    const { serverReadIsCallers, setAccessTokenGetter, takeAnonymousReads } = await import("@/lib/api");
    expect(serverReadIsCallers()).toBe(true); // no auth provider
    setAccessTokenGetter(async () => "t", "loading");
    expect(serverReadIsCallers()).toBe(true);
    expect(takeAnonymousReads()).toBe(true);
    setAccessTokenGetter(async () => "t", "did:privy:a");
    expect(serverReadIsCallers()).toBe(false);
    setAccessTokenGetter(async () => null, "anonymous");
    expect(serverReadIsCallers()).toBe(true);
  });
});
