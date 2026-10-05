import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CoinIndexSkeleton, CoinIndexView } from "@/components/coins/coins-view";
import { fixtureRequest } from "@/fixtures/handler";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/messages/en";
import { coinHref } from "@/lib/coin-slug";
import type { CoinIndexResponse } from "@/lib/contracts";
import { queryKeys } from "@/lib/query-keys";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/coins", notFound: () => { throw new Error("404"); } }));

const wrap = (client: QueryClient, node: React.ReactNode) =>
  renderToString(<QueryClientProvider client={client}><I18nProvider locale="en" messages={en}>{node}</I18nProvider></QueryClientProvider>);

describe("the coin index rendered from the server's read", () => {
  it("puts the markets in the first HTML when the page read them, and only skeletons when it could not", async () => {
    const index = JSON.parse(JSON.stringify(await fixtureRequest("GET", "/discover/coins", undefined, null))) as CoinIndexResponse;
    expect(index.items.length).toBeGreaterThan(0);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const href = `href="/en${coinHref(index.items[0]!.coin)}"`;
    expect(wrap(new QueryClient(), <CoinIndexView initial={{ data: index, fetchedAt: Date.now() }} />)).toContain(href);
    expect(wrap(new QueryClient(), <CoinIndexView />)).not.toContain(href);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("the page's Suspense fallback is skeletons with no query of its own", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    const { default: CoinsPage } = await import("@/app/[locale]/coins/page");
    expect((CoinsPage() as { props: { fallback: { type: unknown } } }).props.fallback.type).toBe(CoinIndexSkeleton);
    const client = new QueryClient();
    expect(wrap(client, <CoinIndexSkeleton />)).toContain("ui-skeleton");
    expect(client.getQueryCache().findAll({ queryKey: queryKeys.discover.coins })).toHaveLength(0);
  });
});
