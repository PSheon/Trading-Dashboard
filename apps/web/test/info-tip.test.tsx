// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InfoTip } from "../src/components/ui/info-tip";
import { Calculator } from "../src/components/home/home-view";
import { fixtureHome } from "../src/fixtures/discovery";
import { I18nProvider } from "../src/i18n/provider";
import { catalogs } from "../src/i18n/messages";
import { en } from "../src/i18n/messages/en";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => "/" }));

/** Text density review 2026-10-12 §3 item 2: explanations live in one ⓘ. */
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.innerHTML = ""; });

const bubble = () => document.querySelector('[data-testid="info-tip-content"]');
const pointer = (el: Element, type: string, pointerType: string) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType }));

describe("InfoTip", () => {
  it("is a labelled button described by its text, with no visible text of its own", async () => {
    await act(async () => root.render(<InfoTip label="More info">Past results do not guarantee future ones.</InfoTip>));
    const button = container.querySelector("button")!;
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("More info");
    expect(button.textContent).toBe("");
    const description = document.getElementById(button.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toBe("Past results do not guarantee future ones.");
    expect(description.className).toContain("sr-only");
    expect(bubble()).toBeNull();
  });

  // React makes pointerenter / pointerleave from pointerover / pointerout.
  it("opens on mouse hover and closes when the mouse leaves; a click keeps it open", async () => {
    await act(async () => root.render(<InfoTip label="More info">Tip</InfoTip>));
    const button = container.querySelector("button")!;
    await act(async () => { pointer(button, "pointerover", "mouse"); });
    expect(bubble()?.textContent).toBe("Tip");
    await act(async () => { pointer(button, "pointerdown", "mouse"); button.click(); });
    expect(bubble()).not.toBeNull();
    await act(async () => { pointer(button, "pointerout", "mouse"); });
    expect(bubble()).toBeNull();
  });

  it("opens on keyboard focus and closes on blur and on Escape", async () => {
    await act(async () => root.render(<InfoTip label="More info">Tip</InfoTip>));
    const button = container.querySelector("button")!;
    await act(async () => { button.focus(); });
    expect(bubble()?.textContent).toBe("Tip");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(bubble()).toBeNull();
    await act(async () => { button.blur(); button.focus(); });
    expect(bubble()).not.toBeNull();
    await act(async () => { button.blur(); });
    expect(bubble()).toBeNull();
  });

  it("toggles on tap, and a tap inside a link neither follows it nor reaches its handler", async () => {
    const onLink = vi.fn();
    await act(async () => root.render(<a href="#card" onClick={onLink}><InfoTip label="More info">Tip</InfoTip></a>));
    const button = container.querySelector("button")!;
    const tap = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => { pointer(button, "pointerdown", "touch"); button.dispatchEvent(tap); });
    expect(tap.defaultPrevented).toBe(true);
    expect(onLink).not.toHaveBeenCalled();
    expect(bubble()?.textContent).toBe("Tip");
    // A tap on the bubble (portalled, but React bubbles it to the link) does not open the card either.
    await act(async () => { (bubble() as HTMLElement).click(); });
    expect(onLink).not.toHaveBeenCalled();
    await act(async () => { pointer(button, "pointerdown", "touch"); button.click(); });
    expect(bubble()).toBeNull();
  });
});

describe("the moved sentences are tips, not lines", () => {
  const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

  it("home: the calculator's disclaimer is an ⓘ that still describes the amount field", () => {
    const sample = fixtureHome().calculator[0];
    const trader = { ...sample, roi: 0.2, sparkline: [10, 20, 30], lastTradeAt: sample.lastTradeAt?.toISOString() ?? null,
      metricsUpdatedAt: sample.metricsUpdatedAt?.toISOString() ?? null, tradesFrom: sample.tradesFrom?.toISOString() ?? null };
    const html = renderToStaticMarkup(<I18nProvider locale="en" messages={en}><Calculator traders={[trader]} /></I18nProvider>);
    expect(html).toContain('aria-describedby="calc-note"');
    expect(html).toMatch(new RegExp(`<span id="calc-note" class="sr-only">${en.home.heroNote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</span>`));
    expect(html).toContain(`aria-label="${en.common.moreInfo}"`);
    expect(html).not.toMatch(/<p id="calc-note"/);
  });

  it.each([
    ["src/components/trader/chart-snapshot-strip.tsx", 't("chartSnap.hint")'],
    ["src/components/insights/positioning-chart.tsx", 't("copyUpdates.historical")'],
    ["src/components/insights/positioning-chart.tsx", 't("insights.cohort.membershipChanged")'],
    ["src/components/coins/coins-view.tsx", 't("coins.method")'],
    ["src/components/trader/copy-panel.tsx", "liveText.testnetNote"],
    ["src/components/portfolio-view.tsx", 't("liveCopyUi.roundingHint")'],
  ])("%s renders %s only inside an InfoTip", (file, expr) => {
    const text = source(file);
    const uses = text.split(expr).length - 1;
    expect(uses, `${expr} in ${file}`).toBeGreaterThan(0);
    const insideTip = text.split(/<InfoTip\b/).slice(1).map((chunk) => chunk.slice(0, chunk.indexOf("</InfoTip>")))
      .reduce((n, chunk) => n + chunk.split(expr).length - 1, 0);
    expect(insideTip).toBe(uses);
  });

  it("a coin page's subtitle keeps both sentences in every language: the first shown, the method in the tip", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(catalog.coins.body, locale).toContain("{coin}");
      expect(catalog.coins.method.length, locale).toBeGreaterThan(10);
      expect(catalog.coins.method, locale).not.toContain("{coin}");
    }
  });
});
