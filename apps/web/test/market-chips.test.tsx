// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { MarketChips } from "@/components/admin/market-chips";
import { I18nProvider } from "@/i18n/provider";
import { catalogs } from "@/i18n/messages";
import { api } from "@/lib/api";
import { installSelectDom } from "./select-helper";

vi.mock("@/components/traders/coin-icon", () => ({ CoinIcon: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }), usePathname: () => "/admin/settings" }));

let root: Root, container: HTMLDivElement, client: QueryClient, changes: string[][];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  installSelectDom();
  vi.spyOn(api, "get").mockResolvedValue({ markets: ["BTC", "ETH", "SOL", "HYPE", "xyz:TSLA", "xyz:AAPL"], volumes: { BTC: 2e9, ETH: 1e9, "xyz:AAPL": 5e6 } } as never);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  changes = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function Harness({ initial, kind = "any" }: { initial: string[]; kind?: "any" | "crypto" | "stocks" }) {
  const [value, setValue] = useState(initial);
  return <MarketChips id="m" kind={kind} label="Markets" value={value} onChange={(next) => { changes.push(next); setValue(next); }} />;
}
async function render(initial: string[], kind?: "any" | "crypto" | "stocks") {
  await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider locale="en" messages={catalogs.en}><Harness initial={initial} kind={kind} /></I18nProvider></QueryClientProvider>));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}
const handle = (coin: string) => container.querySelector<HTMLButtonElement>(`button[aria-label^="Move ${coin},"]`)!;
const key = async (el: Element, name: string) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });

it("reorders with the keyboard on a chip's handle and keeps focus on the moved chip", async () => {
  await render(["BTC", "ETH", "SOL"]);
  expect(container.textContent).toContain("3 / 16");
  handle("SOL").focus();
  await key(handle("SOL"), "Home");
  expect(changes.at(-1)).toEqual(["SOL", "BTC", "ETH"]);
  expect(document.activeElement).toBe(handle("SOL"));
  await key(handle("SOL"), "ArrowRight");
  expect(changes.at(-1)).toEqual(["BTC", "SOL", "ETH"]);
  await key(handle("SOL"), "End");
  expect(changes.at(-1)).toEqual(["BTC", "ETH", "SOL"]);
  await key(handle("BTC"), "ArrowLeft"); // already first: nothing
  expect(changes).toHaveLength(3);
  expect(container.querySelector('[aria-live="polite"]')!.textContent).toBe("SOL moved to 3 of 3");
  await key(handle("ETH"), "Delete");
  expect(changes.at(-1)).toEqual(["BTC", "SOL"]);
});

it("removes with ×, greys a delisted chip, and adds from the exchange's list with type and 24h volume, chosen ones disabled", async () => {
  await render(["BTC", "OLDCOIN", "xyz:TSLA"]);
  const old = [...container.querySelectorAll("li")].find((li) => li.textContent?.includes("OLDCOIN"))!;
  expect(old.getAttribute("title")).toBe("No longer listed on Hyperliquid");
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove OLDCOIN"]')!.click());
  expect(changes.at(-1)).toEqual(["BTC", "xyz:TSLA"]);

  const add = container.querySelector<HTMLButtonElement>('button[aria-label="Add to Markets"]')!;
  await act(async () => add.click());
  const listbox = document.querySelector('[role="listbox"]')!;
  const options = [...listbox.querySelectorAll('[role="option"]')];
  // Largest 24h volume first; the chosen ones are marked and disabled.
  expect(options[0].textContent).toContain("BTC");
  expect(options[0].getAttribute("aria-disabled")).toBe("true");
  expect(options[0].textContent).toContain("Chosen");
  const aapl = options.find((o) => o.textContent?.includes("xyz:AAPL"))!;
  expect(aapl.textContent).toContain("Stock · 24h vol $5");
  const input = document.querySelector<HTMLInputElement>('[role="combobox"][aria-autocomplete="list"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "sol"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await key(input, "Enter");
  expect(changes.at(-1)).toEqual(["BTC", "xyz:TSLA", "SOL"]);
});

it("offers only HIP-3 stocks for a stock list and only main-dex coins for a crypto list", async () => {
  await render(["xyz:TSLA"], "stocks");
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Add to Markets"]')!.click());
  expect([...document.querySelectorAll('[role="option"]')].map((o) => o.getAttribute("data-value"))).toEqual(["xyz:AAPL", "xyz:TSLA"]);
});
