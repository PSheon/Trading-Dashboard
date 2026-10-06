// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SectionBoundary } from "@/components/section-boundary";
import { I18nProvider } from "@/i18n/provider";
import { catalogs } from "@/i18n/messages";

/**
 * A card that crashed on its cached data (logic review 2026-10-06 §C):
 * Retry reads again instead of remounting on the same data and crashing
 * at once.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/en/trader", useSearchParams: () => new URLSearchParams() }));
const reads = vi.fn<() => Promise<{ name: string } | null>>();
function Card() {
  const query = useQuery({ queryKey: ["card"], queryFn: reads, staleTime: Infinity });
  if (query.data === null) throw new Error("the cached data can't be shown");
  return <p>{query.data?.name ?? "loading"}</p>;
}

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

it("Retry after a crash on cached data reads the card's data again", async () => {
  reads.mockResolvedValueOnce(null).mockResolvedValue({ name: "fresh" });
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={catalogs.en}><SectionBoundary><Card /></SectionBoundary></I18nProvider></QueryClientProvider>));
  await settle();
  const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === catalogs.en.common.retry);
  expect(retry).toBeTruthy();
  await act(async () => retry!.click());
  await settle();
  expect(container.textContent).toContain("fresh");
  expect(reads).toHaveBeenCalledTimes(2);
});
