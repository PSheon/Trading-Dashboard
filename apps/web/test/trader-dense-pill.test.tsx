// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { TradesTab } from "../src/components/trader/trade-analytics";
import { catalogs } from "../src/i18n/messages";
import { I18nProvider } from "../src/i18n/provider";

/**
 * Paul, 2026-10-26: a high-frequency account's 交易 tab is one pill,
 * 高頻帳戶, with its sentence (since when nothing closed) on hover.
 */
const state = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../src/lib/queries", () => ({ isComputing: () => false, isUnavailable: () => false, useTraderTrades: () => state.result }));

const zh = catalogs["zh-TW"];
const ADDRESS = `0x${"ab".repeat(20)}`;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.replaceChildren(); });

it("is the 高頻帳戶 pill with the since-sentence in its hover tip; no paragraph", async () => {
  const from = new Date("2026-10-19T04:16:00Z");
  state.result = { data: { pages: [{ address: ADDRESS, items: [], nextCursor: null, total: 0, coverage: { truncated: true, from }, computedAt: new Date() }] }, isError: false, hasNextPage: false };
  await act(async () => root.render(<I18nProvider locale="zh-TW" messages={zh}><TradesTab address={ADDRESS} /></I18nProvider>));

  const pill = container.querySelector<HTMLElement>('[data-testid="trader-dense-pill"]');
  expect(pill).not.toBeNull();
  const tip = pill!.querySelector("button")!;
  const description = document.getElementById(tip.getAttribute("aria-describedby")!)!;
  expect(description.className).toContain("sr-only");
  const [before, after] = zh.trader.denseDesc.split("{since}");
  expect(description.textContent!.startsWith(before) && description.textContent!.endsWith(after)).toBe(true);
  expect(description.textContent).not.toContain("{since}");
  // The date reads in the page's language inside a sentence (2026-10-26: was "Oct 19, 04:27" in a zh-TW sentence).
  expect(description.textContent).toContain("2026年10月19日");
  expect(description.textContent).not.toMatch(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
  expect((pill!.textContent ?? "").replace(description.textContent!, "")).toBe(zh.trader.denseTitle);
  expect(container.querySelectorAll("p")).toHaveLength(0);

  expect(document.querySelector('[data-testid="info-tip-content"]')).toBeNull();
  await act(async () => { tip.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })); });
  expect(document.querySelector('[data-testid="info-tip-content"]')?.textContent).toBe(description.textContent);
});
