// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InsightsView } from "@/components/insights/insights-view";
import { fixtureCohort } from "@/fixtures/discovery";
import { I18nProvider } from "@/i18n/provider";
import { catalogs } from "@/i18n/messages";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/use-is-desktop", () => ({ useIsDesktop: () => true }));
vi.mock("@/lib/queries", () => ({ useCohort: () => ({ data: fixtureCohort("profit"), isError: false, isFetching: false, refetch: vi.fn() }), useCohortHistory: () => ({ data: undefined, isError: false }) }));
vi.mock("@/components/insights/positioning-chart", () => ({ PositioningChart: () => null }));
vi.mock("@/components/insights/market-treemap", () => ({ MarketTreemap: () => null }));
let root: Root, container: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = () => act(async () => root.render(<I18nProvider locale="en" messages={catalogs.en}><InsightsView /></I18nProvider>));
const key = (button: HTMLElement, value: string) => act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
it("names cohort tabs and switches their actual content with one keyboard tab stop", async () => {
  await render();
  const group = container.querySelector('[role="tablist"]')!;
  expect(group.getAttribute("aria-label")).toBeTruthy();
  const tabs = [...group.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs.filter(t => t.tabIndex === 0)).toHaveLength(1);
  tabs[0].focus(); await key(tabs[0], "ArrowRight");
  expect(tabs[1].getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tabs[1]);
  const panel = container.querySelector('[role="tabpanel"]')!;
  expect(panel).not.toBeNull();
  expect(tabs[1].getAttribute("aria-controls")).toBe(panel.id);
  expect(panel.getAttribute("aria-labelledby")).toBe(tabs[1].id);
  expect(container.querySelector('[role="radiogroup"]')).not.toBeNull();
  await key(tabs[1], "Home");
  expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  expect(container.querySelector('[role="radiogroup"]')).toBeNull();
});
it("changes market filtering with radio arrow keys and keeps only its active choice tabbable", async () => {
  await render();
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click());
  const group = container.querySelector('[role="radiogroup"]')!;
  expect(group.getAttribute("aria-label")).toBeTruthy();
  const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  expect(radios.filter(r => r.tabIndex === 0)).toHaveLength(1);
  radios[0].focus(); await key(radios[0], "ArrowRight");
  expect(radios[1].getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(radios[1]);
  expect(container.querySelector("table")!.textContent).toContain("BTC");
  expect(container.querySelector("table")!.textContent).not.toContain("SP500");
  await key(radios[1], "End");
  expect(radios[2].getAttribute("aria-checked")).toBe("true");
  expect(container.querySelector("table")!.textContent).not.toContain("BTC");
});

it('keeps the five market sorting controls named and focusable with 44px targets while sorting the real table rows', async () => {
  await render();
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click());
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1].click());
  const table = container.querySelector<HTMLTableElement>('table')!;
  const heads = [...table.querySelectorAll<HTMLTableCellElement>('thead th[aria-sort]')];
  expect(heads).toHaveLength(5);
  for (const head of heads) {
    const button = head.querySelector<HTMLButtonElement>('button')!;
    expect(button.textContent?.trim()).toBeTruthy();
    button.focus(); expect(document.activeElement).toBe(button);
    // Target sizes belong to the actual interactive descendant, not the
    // padded header cell. Browser acceptance measures the compiled CSS.
    expect(head.classList.contains('[&>button]:min-h-11')).toBe(true);
    expect(head.classList.contains('[&>button]:min-w-11')).toBe(true);
  }
  const market = heads[0], button = market.querySelector<HTMLButtonElement>('button')!;
  const coins = () => [...table.querySelectorAll('tbody tr')].map(row => row.querySelector('td')!.textContent!.trim());
  await act(async () => button.click());
  expect(market.getAttribute('aria-sort')).toBe('descending');
  expect(coins()).toEqual([...coins()].sort((a, b) => b.localeCompare(a)));
  await act(async () => button.click());
  expect(market.getAttribute('aria-sort')).toBe('ascending');
  expect(coins()).toEqual([...coins()].sort((a, b) => a.localeCompare(b)));
  expect(table.classList.contains('min-w-[1080px]')).toBe(true);
});
