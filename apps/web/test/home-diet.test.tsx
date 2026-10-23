import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { HOME_ROW_SIZE, HomeView, homeRows } from "@/components/home/home-view";
import { fixtureRequest } from "@/fixtures/handler";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import { HOME_TILE_CRYPTO, HOME_TILE_STOCKS, type BoardTrader, type HomeBoardsResponse } from "@/lib/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/" }));

/**
 * Home diet (2026-10-23): the home rendered twelve rows of seven cards (精選,
 * 頂尖加密, 頂尖股票, then one per market) with the same addresses recurring
 * across them. It keeps the three rows; the markets are the one row of
 * tiles that lead to each market's explore tab; a trader shown in an earlier
 * row is not repeated in a later one.
 */
const render = (home: HomeBoardsResponse) => renderToString(
  <QueryClientProvider client={new QueryClient()}>
    <I18nProvider locale="en" messages={en}><HomeView initial={{ home: { data: home, fetchedAt: Date.now() } }} /></I18nProvider>
  </QueryClientProvider>,
);
const fixture = async () => JSON.parse(JSON.stringify(await fixtureRequest("GET", "/discover/home", undefined, null))) as HomeBoardsResponse;
/** The trader each home card links to, in order. */
const cards = (html: string) => [...html.matchAll(/<article[^>]*><a [^>]*href="\/en\/trader\/(0x[0-9a-f]+)"/g)].map((m) => m[1]);

describe("home diet", () => {
  it("renders exactly three card rows, no trader twice, and no per-market row", async () => {
    const home = await fixture();
    // The fixture's rows do overlap, as the api's do (the top KOL is also a top crypto trader).
    expect(home.featured.some((t) => home.crypto.some((c) => c.address === t.address))).toBe(true);
    expect(home.markets.length).toBeGreaterThan(0);
    const html = render(home);
    expect(html.match(/aria-label="See all · /g)).toHaveLength(3);
    for (const title of [en.home.featured, en.home.topCrypto, en.home.topStock]) expect(html).toContain(`<h2 class="type-h2">${title}</h2>`);
    const shown = cards(html);
    expect(shown.length).toBeGreaterThan(0);
    expect(new Set(shown).size).toBe(shown.length);
    // No market row: no card from the markets' own lists beyond the three rows, no coin heading.
    expect(shown.length).toBeLessThanOrEqual(3 * HOME_ROW_SIZE);
    expect(html).not.toMatch(/<h2 class="type-h2[^"]*"><img/);
  });

  it("the market tiles link to the market's explore tab", async () => {
    const html = render(await fixture());
    for (const coin of HOME_TILE_CRYPTO) expect(html).toContain(`href="/en/explore?board=${encodeURIComponent(coin)}&amp;sort=pnl"`);
    for (const coin of HOME_TILE_STOCKS) expect(html).toContain(`href="/en/explore?market=stocks&amp;board=${encodeURIComponent(coin)}&amp;sort=pnl"`);
  });

  it("a trader an earlier row shows gives its slot to the row's next candidate", () => {
    const trader = (address: string) => ({ address }) as BoardTrader;
    const rows = homeRows([
      { items: ["a", "b", "c", "d", "e", "f", "g", "h"].map(trader) },
      { items: ["a", "x", "c", "y", "z", "p", "q", "r", "s", "t"].map(trader) },
      { items: ["x", "k"].map(trader) },
    ]);
    expect(rows[0].items.map((t) => t.address)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(rows[1].items.map((t) => t.address)).toEqual(["x", "y", "z", "p", "q", "r", "s"]);
    expect(rows[2].items.map((t) => t.address)).toEqual(["k"]);
  });
});
