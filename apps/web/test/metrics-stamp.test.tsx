// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardCard, BoardMobileRow, HomeCard } from "../src/components/discover/board-card";
import { fixtureHome } from "../src/fixtures/discovery";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import type { BoardTrader } from "../src/lib/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/" }));
vi.mock("next/link", () => ({ default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => <a href={href} className={className}>{children}</a> }));

/**
 * Text density review 2026-10-12 §1.1: the metrics stamp was two grey lines
 * on every card. Fresh metrics now show nothing; metrics over 24 h old show
 * a clock whose tip (hover, focus or tap) gives the update time.
 */
const NOW = Date.parse("2026-10-12T12:00:00Z");
const sample = fixtureHome().calculator[0];
const traderAt = (metricsUpdatedAt: string | null): BoardTrader => ({ ...sample,
  lastTradeAt: sample.lastTradeAt?.toISOString() ?? null,
  tradesFrom: sample.tradesFrom?.toISOString() ?? null,
  metricsUpdatedAt } as unknown as BoardTrader);

const kinds = {
  board: (trader: BoardTrader) => <BoardCard trader={trader} pnlLabel="PnL" roiLabel="ROI" now={NOW} />,
  home: (trader: BoardTrader) => <HomeCard trader={trader} />,
  row: (trader: BoardTrader) => <ul><BoardMobileRow trader={trader} /></ul>,
};

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});
const render = (node: React.ReactNode) => act(async () => root.render(<I18nProvider locale="en" messages={en}>{node}</I18nProvider>));
const stamp = () => container.querySelector<HTMLButtonElement>(`button[aria-label="${en.discover.metricsStale}"]`);

describe.each(Object.entries(kinds))("the %s card's metrics stamp", (_kind, card) => {
  it("is not rendered while the metrics are under 24 hours old", async () => {
    await render(card(traderAt(new Date(NOW - 23 * 3_600_000).toISOString())));
    expect(stamp()).toBeNull();
    expect(container.textContent).not.toContain(en.discover.metricsUpdated);
    expect(container.querySelector("time[datetime]")).toBeNull();
  });

  it("is not rendered without a metrics time", async () => {
    await render(card(traderAt(null)));
    expect(stamp()).toBeNull();
  });

  it("is a clock button past 24 hours, whose tip gives the update time on tap and on focus", async () => {
    const at = "2026-10-10T12:37:00.000Z";
    await render(card(traderAt(at)));
    const button = stamp()!;
    expect(button).not.toBeNull();
    expect(button.getAttribute("type")).toBe("button");
    // No visible line: only the icon is in the card.
    expect(button.textContent).toBe("");
    // The update time is the button's description, so it is read without opening.
    const description = document.getElementById(button.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toContain(en.discover.metricsUpdated);
    expect(description.textContent).toContain("(UTC)");
    expect(description.querySelector("time")!.getAttribute("datetime")).toBe(at);
    expect(document.querySelector('[data-testid="info-tip-content"]')).toBeNull();

    // A tap opens the bubble and does not follow the card's link.
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
      button.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    const bubble = document.querySelector('[data-testid="info-tip-content"]')!;
    expect(bubble.textContent).toContain(en.discover.metricsStale);
    expect(bubble.querySelector("time")!.getAttribute("datetime")).toBe(at);
    // A second tap closes it.
    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[data-testid="info-tip-content"]')).toBeNull();

    // Keyboard focus opens it as well.
    await act(async () => { button.blur(); button.focus(); });
    expect(document.querySelector('[data-testid="info-tip-content"]')).not.toBeNull();
  });
});

it("stale metrics and 'last trade … ago' are different glyphs: the clock means the last trade only", async () => {
  const trader = { ...traderAt("2026-10-10T12:37:00.000Z"), lastTradeAt: new Date(NOW - 29 * 86_400_000).toISOString() };
  await render(kinds.board(trader));
  const stale = stamp()!.querySelector("svg")!;
  expect(stale.getAttribute("class")).not.toMatch(/clock/);
  expect(stale.getAttribute("class")).toContain("lucide-triangle-alert");
  const lastTrade = [...container.querySelectorAll("svg")].find((svg) => /lucide-clock/.test(svg.getAttribute("class") ?? ""))!;
  expect(lastTrade).toBeDefined();
  expect(lastTrade.closest("button")).toBeNull();
  expect(lastTrade.parentElement!.textContent).toContain("ago");
});
