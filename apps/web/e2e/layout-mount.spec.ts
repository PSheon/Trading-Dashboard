import { expect, test } from "@playwright/test";
import { firstTraderLink } from "./helpers";

const TRADER = "/trader/0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f";

/** A phone mounts the phone layout only (and a desktop the desktop one):
 * the hidden copy used to run its own reads — the desktop trader page's
 * fills ×2000 poll among them — and doubled explore's 100 traders. */
test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

test("a phone trader page has no desktop layout in the document, and a desktop one no phone layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(TRADER);
  await expect(page.getByRole("radiogroup", { name: "Trading activity" })).toBeVisible();
  await expect(page.locator(".trader-grid")).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "Trading activity" })).toHaveCount(0);
  await expect(page.locator("h1")).toHaveCount(1);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("tablist", { name: "Trading activity" })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Trading activity" })).toHaveCount(0);
  await expect(page.locator(".trader-grid")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveCount(1);
});

test("explore draws each trader once at either width", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/explore");
    await expect(firstTraderLink(page)).toBeVisible();
    const visible = await page.locator('a[href^="/trader/"]').filter({ visible: true }).count();
    expect(visible, `visible at ${width}`).toBeGreaterThan(0);
    // Every trader link in the document is on screen: nothing hidden twice.
    expect(await page.locator('a[href^="/trader/"]').filter({ visible: false }).count(), `hidden at ${width}`).toBe(0);
  }
});
