// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ExposurePanel } from "../src/components/copy/portfolio-parts";
import { fixtureCopyOverview } from "../src/fixtures/copy";
import type { CopyOverview } from "../src/lib/contracts";
import { I18nProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/messages/en";
import { Collapsible, CollapsibleTrigger } from "../src/components/ui/collapsible";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <CollapsibleTrigger open={open} controls="parts" onOpenChange={setOpen}>More</CollapsibleTrigger>
      <Collapsible open={open} id="parts" className="pt-3"><a href="#x">inside</a></Collapsible>
    </>
  );
}

it("stays mounted, inert and aria-hidden while closed; the trigger says it is expanded and which panel it controls", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<Harness />); });
    const trigger = container.querySelector("button")!;
    const panel = container.querySelector<HTMLElement>("#parts")!;
    expect(trigger.getAttribute("type")).toBe("button");
    expect(trigger.getAttribute("aria-controls")).toBe("parts");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // Mounted while closed, so it can animate open.
    expect(panel.textContent).toBe("inside");
    expect(panel.hasAttribute("inert")).toBe(true);
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    expect(panel.dataset.open).toBe("false");
    expect(panel.className).toBe("collapse-panel");
    // The content (with its padding) sits inside the clipping child.
    expect(panel.firstElementChild!.firstElementChild!.className).toBe("pt-3");

    await act(async () => { trigger.click(); });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hasAttribute("inert")).toBe(false);
    expect(panel.hasAttribute("aria-hidden")).toBe(false);
    expect(panel.dataset.open).toBe("true");

    await act(async () => { trigger.click(); });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hasAttribute("inert")).toBe(true);
  } finally { await act(async () => root.unmount()); }
});

it("animates its row from 0fr to 1fr with a transition, and not at all under prefers-reduced-motion", () => {
  const rule = (selector: string, from = 0) => {
    const at = css.indexOf(`${selector} {`, from);
    return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  };
  expect(rule(".collapse-panel")).toMatch(/grid-template-rows:\s*0fr/);
  expect(rule(".collapse-panel")).toMatch(/transition:\s*grid-template-rows/);
  expect(rule('.collapse-panel[data-open="true"]')).toMatch(/grid-template-rows:\s*1fr/);
  expect(rule(".collapse-panel > *")).toMatch(/overflow:\s*hidden/);
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
  expect(reduced).toMatch(/\.collapse-panel, \.collapse-panel\[data-open="true"\] \{ transition: none; \}/);
});

it("opens a coin's copies in the portfolio exposure with the same Collapsible", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const overview: CopyOverview = JSON.parse(JSON.stringify(fixtureCopyOverview()));
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<I18nProvider locale="en" messages={en}><ExposurePanel overview={overview} leaders={new Map()} desktop /></I18nProvider>); });
    const trigger = container.querySelector<HTMLButtonElement>("li > button[aria-expanded]")!;
    const panel = container.querySelector<HTMLElement>(`[id="${trigger.getAttribute("aria-controls")}"]`)!;
    expect(panel.className).toBe("collapse-panel");
    expect(panel.hasAttribute("inert")).toBe(true);
    expect(panel.querySelectorAll("li").length).toBeGreaterThan(0);
    await act(async () => { trigger.click(); });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hasAttribute("inert")).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
