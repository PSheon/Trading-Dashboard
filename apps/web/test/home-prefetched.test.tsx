import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { HomeView } from "@/components/home/home-view";
import { fixtureRequest } from "@/fixtures/handler";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/" }));

const render = (initial?: NonNullable<Parameters<typeof HomeView>[0]>["initial"]) => renderToString(
  <QueryClientProvider client={new QueryClient()}>
    <I18nProvider locale="en" messages={en}><HomeView initial={initial} /></I18nProvider>
  </QueryClientProvider>,
);

describe("home rendered from the server's read", () => {
  it("puts the traders in the first HTML when the page read the rows, and only skeletons when it could not", async () => {
    const home = JSON.parse(JSON.stringify(await fixtureRequest("GET", "/discover/home", undefined, null)));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const first = home.featured[0].address as string;
    expect(render({ home: { data: home, fetchedAt: Date.now() } })).toContain(`href="/trader/${first}"`);
    expect(render()).not.toContain(`href="/trader/${first}"`);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("依市場瀏覽 tiles", () => {
  it("are CopyDog's five fixed tiles per kind followed by the api's trending markets", async () => {
    const home = JSON.parse(JSON.stringify(await fixtureRequest("GET", "/discover/home", undefined, null)));
    const html = render({ home: { data: { ...home, trending: { coins: ["ZEC", "PUMP"], stocks: ["xyz:CBRS", "xyz:BRENTOIL"] } }, fetchedAt: Date.now() } });
    const tilesOf = (markup: string) => /data-testid="phone-crypto-tiles"([\s\S]*?)<\/div>/.exec(markup)?.[1] ?? "";
    const tiles = tilesOf(html);
    const order = [...tiles.matchAll(/href="\/explore\?board=([^"&]+)/g)].map((m) => decodeURIComponent(m[1]));
    expect(order).toEqual(["BTC", "ETH", "SOL", "HYPE", "DOGE", "ZEC", "PUMP"]);
    expect(html).toContain("board=xyz%3ACBRS");
    // An api without the field: the fixed tiles only.
    const plain = tilesOf(render({ home: { data: home, fetchedAt: Date.now() } }));
    expect([...plain.matchAll(/href="\/explore\?board=([^"&]+)/g)].map((m) => m[1])).toEqual(["BTC", "ETH", "SOL", "HYPE", "DOGE"]);
  });
});
