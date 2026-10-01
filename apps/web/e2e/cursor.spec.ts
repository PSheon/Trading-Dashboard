import { test, expect, type Page } from "@playwright/test";
import { openFirstTrader } from "./helpers";

/** Computed cursor per element type, as copydog.xyz shows it: the hand on
 * every control that acts on click, not-allowed on disabled ones, the
 * I-beam in text fields. */
async function sample(page: Page) {
  return page.evaluate(() => {
    const kinds: Record<string, string> = {
      button: "button:not(:disabled)",
      disabled: "button:disabled",
      link: "a[href]",
      tab: '[role="tab"]',
      radio: '[role="radio"]:not(:disabled)',
      menuitem: '[role="menuitem"]',
      option: '[role="option"]',
      sortHeader: "th button",
      textInput: 'input:not([type="range"]):not([type="checkbox"]):not([type="radio"])',
    };
    const out: Record<string, { cursors: string[]; count: number }> = {};
    for (const [kind, selector] of Object.entries(kinds)) {
      const visible = [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
      if (visible.length === 0) continue;
      out[kind] = { cursors: [...new Set(visible.map((el) => getComputedStyle(el).cursor))], count: visible.length };
    }
    return out;
  });
}

const expected: Record<string, string[]> = {
  button: ["pointer"],
  disabled: ["not-allowed"],
  link: ["pointer"],
  tab: ["pointer"],
  radio: ["pointer"],
  menuitem: ["pointer"],
  option: ["pointer"],
  sortHeader: ["pointer"],
  textInput: ["text"],
};

for (const path of ["/", "/explore", "/favorites", "/settings"]) {
  test(`cursor per element type on ${path}`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
    await page.goto(path);
    await expect(page.getByRole("button").first()).toBeVisible();
    const found = await sample(page);
    for (const [kind, { cursors }] of Object.entries(found)) expect(cursors, `${kind} on ${path}`).toEqual(expected[kind]);
  });
}

test("cursor per element type on a trader page", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await page.goto("/explore");
  await openFirstTrader(page);
  await expect(page.getByRole("tablist", { name: "Trading activity" })).toBeVisible();
  const found = await sample(page);
  for (const [kind, { cursors }] of Object.entries(found)) expect(cursors, kind).toEqual(expected[kind]);
});
