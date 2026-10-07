// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FillsTab } from "../src/components/trader/trader-tabs";
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

afterEach(() => { document.body.replaceChildren(); });

const bodyRows = (el: HTMLElement) => el.querySelectorAll("tbody tr").length;
const button = (el: HTMLElement, name: string) => [...el.querySelectorAll<HTMLButtonElement>("nav button")].find((b) => b.textContent?.includes(name))!;

describe("成交 with 2,000 rows that don't merge", () => {
  it("shows ten a page with the shared pager, and a new sort starts again on page 1", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => root.render(<I18nProvider locale="en" messages={en}><FillsTab rows={fills} /></I18nProvider>));
    expect(bodyRows(el)).toBe(10);
    expect(el.querySelector("[data-pager]")?.textContent).toContain("Page 1 of 200");
    expect(button(el, "Previous").disabled).toBe(true);
    await act(async () => button(el, "Next").click());
    expect(bodyRows(el)).toBe(10);
    expect(el.querySelector("[data-pager]")?.textContent).toContain("Page 2 of 200");
    await act(async () => el.querySelector<HTMLButtonElement>("thead button")!.click());
    expect(el.querySelector("[data-pager]")?.textContent).toContain("Page 1 of 200");
    await act(async () => root.unmount());
  });
});
