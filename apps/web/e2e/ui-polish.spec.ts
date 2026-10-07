import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, shot } from "./helpers";

test.beforeEach(async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await context.addInitScript(() => localStorage.setItem("fixture-signed-in", "1"));
  await page.setViewportSize({ width: 390, height: 844 });
});

for (const reducedMotion of ["no-preference", "reduce"] as const) test(`bottom nav pill follows the active link (${reducedMotion})`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion });
  await page.goto("/en");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const pill = nav.locator('[data-nav-pill]');
  await expect(pill).toBeVisible();
  const before = await pill.evaluate(el => (el as HTMLElement).style.transform);
  await nav.getByRole("link", { name: "Explore", exact: true }).click();
  await expect(page).toHaveURL(/\/explore/);
  await expect.poll(() => pill.evaluate(el => (el as HTMLElement).style.transform)).not.toBe(before);
  await expect.poll(async () => {
    const p = await pill.boundingBox(), link = await nav.getByRole("link", { name: "Explore", exact: true }).boundingBox();
    return Math.abs((p?.x ?? -100) - (link?.x ?? 0));
  }).toBeLessThan(1);
  expect(await pill.evaluate(el => getComputedStyle(el).transitionDuration)).toBe(reducedMotion === "reduce" ? "0s" : "0.25s, 0.25s, 0.25s");
  await expectNoSidewaysScroll(page);
  await shot(page, `nav-pill-${reducedMotion}`);
});

test("copy sheet mode covers its whole scroll viewport without a top gap", async ({ page, context }) => {
  await context.routeWebSocket(/hyperliquid/, ws => ws.close());
  await page.goto("/en/trader/0x393d0b87ed38fc779fd9611144ae649ba6082109");
  await page.getByRole("button", { name: "Copy", exact: true }).filter({ visible: true }).click();
  const body = page.getByTestId("copy-sheet-body"), mode = page.getByTestId("copy-sheet-mode");
  await expect(body).toBeVisible();
  expect(await body.evaluate(el => getComputedStyle(el).paddingTop)).toBe("0px");
  for (const top of [40, 180, 350]) {
    await body.evaluate((el, top) => { el.scrollTop = top; }, top);
    await expect(body).toHaveAttribute("data-scrolled", "true");
    // Read both rectangles in one browser frame: the sheet can still be
    // entering, so two separate boundingBox calls compare different positions.
    await expect.poll(() => body.evaluate(el => {
      const viewport = el.getBoundingClientRect();
      const sticky = el.querySelector('[data-testid="copy-sheet-mode"]')!.getBoundingClientRect();
      return Math.max(Math.abs(sticky.y - viewport.y), Math.abs(sticky.x - viewport.x), Math.abs(sticky.width - viewport.width));
    })).toBeLessThan(1);
    expect(await mode.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe("none");
  }
  await body.evaluate(el => { el.scrollTop = 0; });
  await expect(body).toHaveAttribute("data-scrolled", "false");
  await page.getByRole("dialog", { name: "Copy", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  await expect(body).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});
