import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { CHROME, UNDER_PHONE_BAR } from "@/components/shell/chrome";

const css = readFileSync(join(__dirname, "../src/app/globals.css"), "utf8");
const px = (name: string) => { const m = css.match(new RegExp(`${name}:\\s*(\\d+)px`)); expect(m, name).not.toBeNull(); return Number(m![1]); };

/** 2026-10-23: the phone pages' bottom padding (96px / 100px) and the
 * floating bar's size (68px at 12px) were unrelated numbers in two files.
 * The clearance is now derived from the bar's own height and offset, and
 * every phone layout with a floating bar (the tab bar, a trader's 跟單
 * bar) pads by it, so the last content and the trader page's tab row never
 * sit under the bar. */
it("pads every phone layout with a floating bar by the bar's own height and offset", () => {
  const height = px("--phone-bar-height"), offset = px("--phone-bar-offset");
  expect(height).toBe(68);
  expect(offset).toBe(12);
  expect(css).toMatch(/--phone-bar-clearance:\s*calc\(var\(--phone-bar-offset\) \+ var\(--phone-bar-height\) \+ (\d+)px\)/);
  const gap = Number(css.match(/--phone-bar-clearance:\s*calc\(var\(--phone-bar-offset\) \+ var\(--phone-bar-height\) \+ (\d+)px\)/)![1]);
  expect(gap).toBeGreaterThanOrEqual(12);
  // The bar itself is drawn from the same variables.
  const bar = css.slice(css.indexOf(".phone-floating-bar {"));
  expect(bar).toMatch(/height:\s*var\(--phone-bar-height\)/);
  expect(bar).toMatch(/bottom:\s*calc\(var\(--phone-bar-offset\) \+ env\(safe-area-inset-bottom/);
  expect(UNDER_PHONE_BAR).toBe("pb-[calc(var(--phone-bar-clearance)+env(safe-area-inset-bottom))]");
  for (const group of ["(app)", "(app-fill)", "(detail)", "(admin)"] as const) {
    expect(CHROME[group].phonePad, group).toContain(UNDER_PHONE_BAR);
  }
  // A trader page has the 跟單 bar instead of the tab bar: the same clearance.
  expect(CHROME["(detail)"].tabBar).toBe(false);
  expect(CHROME["(detail)"].phonePad).toContain("pt-[72px]");
});
