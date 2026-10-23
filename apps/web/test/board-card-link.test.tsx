// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { BoardCard } from "../src/components/discover/board-card";
import { boardName } from "../src/components/discover/board-bits";
import { fixtureHome } from "../src/fixtures/discovery";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import type { BoardTrader } from "../src/lib/contracts";

const pushed: string[] = [];
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push(href: string) { pushed.push(href); } }), usePathname: () => "/" }));
vi.mock("next/link", () => ({ default: ({ children, href, prefetch: _prefetch, ...rest }: { children: React.ReactNode; href: string; prefetch?: boolean } & React.ComponentProps<"a">) => <a href={href} {...rest}>{children}</a> }));

/**
 * The explore card was one `<a>` wrapping everything, 跟單 `<button>` included:
 * a button inside a link is invalid HTML, and the link's accessible name was
 * the whole card's text. The link is now the trader's name (its name is the
 * name only), stretched over the card with a pseudo-element; the button is
 * a sibling above it.
 */
const NOW = Date.parse("2026-10-12T12:00:00Z");
const sample = fixtureHome().calculator[0];
const trader: BoardTrader = { ...sample,
  lastTradeAt: sample.lastTradeAt?.toISOString() ?? null,
  tradesFrom: sample.tradesFrom?.toISOString() ?? null,
  metricsUpdatedAt: "2026-10-10T12:37:00.000Z" } as unknown as BoardTrader;

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  pushed.length = 0;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.innerHTML = ""; });

it("the card's link is named after the trader only, and 跟單 is not inside it", async () => {
  await act(async () => root.render(<I18nProvider locale="en" messages={en}><BoardCard trader={trader} pnlLabel="PnL" roiLabel="ROI" roiHint="PnL ÷ notional" now={NOW} accessory={<button type="button">star</button>} /></I18nProvider>));
  const links = [...container.querySelectorAll("a[href]")];
  expect(links.map((a) => a.getAttribute("href"))).toEqual([`/en/trader/${trader.address}`]);
  const link = links[0]!;
  expect(link.getAttribute("aria-label") ?? link.textContent).toBe(boardName(trader));
  const copy = [...container.querySelectorAll("button")].find((b) => b.textContent === en.discover.copy)!;
  expect(copy).toBeDefined();
  expect(link.contains(copy)).toBe(false);
  expect(copy.closest("a")).toBeNull();
  // Neither is any other control: the stale-metrics tip, the ROI tooltip, the accessory.
  for (const control of container.querySelectorAll("button, [tabindex]")) expect(control.closest("a")).toBeNull();
  // The card is one frame: the link stretches over it, the controls sit above.
  const card = link.closest(".orbit-card")!;
  expect(card.contains(copy)).toBe(true);
  expect(card.className.split(" ")).toContain("relative");
  expect(link.className).toMatch(/after:absolute/);
  expect(link.className).toMatch(/after:inset-0/);
  expect(copy.className.split(" ")).toEqual(expect.arrayContaining(["relative", "z-10"]));
  await act(async () => { copy.click(); });
  expect(pushed).toEqual([`/en/trader/${trader.address}#copy-amount`]);
});
