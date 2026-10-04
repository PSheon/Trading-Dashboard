// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FILL_ROWS_STEP, FillsTab } from "../src/components/trader/trader-tabs";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import type { TraderFill } from "../src/lib/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 2,000 fills that never merge: the coin alternates on every one.
const now = Date.UTC(2026, 9, 1);
const fills: TraderFill[] = Array.from({ length: 2000 }, (_, i) => ({
  tid: String(i), coin: i % 2 ? "BTC" : "ETH", side: "buy", dir: "Open Long", px: 100 + i, sz: 1, notionalUsd: 100 + i,
  closedPnl: 0, fee: 0, ts: new Date(now - i * 60_000).toISOString(), twapId: null, startPosition: 0, liquidation: false,
}));

let observers: Array<{ callback: IntersectionObserverCallback; target: Element | null }> = [];
class FakeObserver {
  entry: { callback: IntersectionObserverCallback; target: Element | null };
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, target: null };
    observers.push(this.entry);
  }
  observe(target: Element) { this.entry.target = target; }
  disconnect() { observers = observers.filter((o) => o !== this.entry); }
  unobserve() {}
  takeRecords() { return []; }
}

afterEach(() => { vi.unstubAllGlobals(); observers = []; document.body.replaceChildren(); });

const bodyRows = (el: HTMLElement) => el.querySelectorAll("tbody tr").length;

describe("成交 with 2,000 rows that don't merge", () => {
  it("puts one step of rows in the page, and the next as the end comes near, until all are there", async () => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => root.render(<I18nProvider locale="en" messages={en}><FillsTab rows={fills} /></I18nProvider>));
    expect(bodyRows(el)).toBe(FILL_ROWS_STEP);
    const near = async () => {
      const o = observers.at(-1)!;
      await act(async () => o.callback([{ isIntersecting: true, target: o.target } as IntersectionObserverEntry], {} as IntersectionObserver));
    };
    await near();
    expect(bodyRows(el)).toBe(2 * FILL_ROWS_STEP);
    for (let i = 0; i < 20 && bodyRows(el) < 2000; i++) await near();
    expect(bodyRows(el)).toBe(2000);
    // Everything shown: no marker, nothing left to observe.
    expect(observers).toHaveLength(0);
    // A new sort starts again from the top.
    await act(async () => el.querySelector<HTMLButtonElement>("thead button")!.click());
    expect(bodyRows(el)).toBe(FILL_ROWS_STEP);
    await act(async () => root.unmount());
  });

  it("without IntersectionObserver every row is rendered", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => root.render(<I18nProvider locale="en" messages={en}><FillsTab rows={fills} /></I18nProvider>));
    expect(bodyRows(el)).toBe(2000);
    await act(async () => root.unmount());
  });
});
