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

test("cohort headers stick inside the table's single scrolling viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/en/insights");
  const table = page.locator('table.cd-cohort-wallets').filter({ visible: true });
  await expect(table).toBeVisible();
  const viewport = table.locator('..');
  await expect.poll(() => viewport.evaluate(el => { el.scrollTop = 60; return el.scrollTop; })).toBeGreaterThan(0);
  const gap = await viewport.evaluate(el => Math.abs(el.querySelector('thead')!.getBoundingClientRect().y - el.getBoundingClientRect().y));
  expect(gap).toBeLessThan(1);
});

test("phone trader chrome floats like the home nav and fades scrolling content under its header", async ({ page }) => {
  await page.goto("/en");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav).toBeVisible();
  const home = await nav.boundingBox();
  await page.goto("/en/trader/0xbf732ea04197942783e34730ed6e0f6099575d58");
  const bar = page.getByTestId("trader-copy-bar");
  const header = page.getByTestId("trader-phone-header");
  const scrim = header.locator(".bar-scrim");
  await expect(bar).toBeVisible();
  const bounds = await bar.boundingBox();
  expect(bounds!.x).toBe(home!.x);
  expect(bounds!.width).toBe(home!.width);
  expect(bounds!.y).toBe(home!.y);
  expect(bounds!.height).toBe(home!.height);
  expect(await bar.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe("none");
  for (const width of [320, 390, 767]) {
    await page.setViewportSize({ width, height: 844 });
    for (const control of await header.locator("button,a").all()) {
      const box = await control.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expectNoSidewaysScroll(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => scrim.evaluate(el => getComputedStyle(el).opacity)).toBe("0");
  await page.evaluate(() => window.scrollTo(0, 250));
  await expect.poll(() => scrim.evaluate(el => getComputedStyle(el).opacity)).toBe("1");
  expect(await scrim.evaluate(el => getComputedStyle(el).pointerEvents)).toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await scrim.evaluate(el => getComputedStyle(el).transitionDuration)).toBe("0s");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const bottom = await page.locator("main").evaluate(el => el.getBoundingClientRect().bottom);
  expect(bottom).toBeLessThan((await bar.boundingBox())!.y);
  await shot(page, "trader-floating-390");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(bar).toBeHidden();
  await expectNoSidewaysScroll(page);
});
