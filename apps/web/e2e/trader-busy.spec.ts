import { expect, test, type Page } from "@playwright/test";

/** The trader's account value: drawn only once the profile is in (the
 * loading outline shows the label, not the figure). */
const profileIn = (page: Page) => page.getByTestId("account-value").filter({ visible: true });

const TRADER = "/trader/0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f";
const failed = (page: Page) => page.getByText("Couldn't load this trader.", { exact: true });
const placeholders = (page: Page) => page.locator("main .ui-skeleton, main .animate-pulse").filter({ visible: true });
/** The fixture api answers the trader page's requests 503 busy (see fixtures/handler.ts). */
const busy = (page: Page, spec: string) => page.addInitScript((value) => sessionStorage.setItem("orbie:fixtures:trader-busy", value), spec);

test.beforeEach(async ({ context, baseURL, page }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  // Time runs as usual; the tests jump over the retry waits (5 s, 10 s, 15 s).
  await page.clock.install();
});

for (const width of [1440, 390]) {
  test.describe(`trader page while the api is busy, ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test("503s are retried silently and the page fills in without anyone touching it", async ({ page }) => {
      test.setTimeout(90000);
      await busy(page, "2");
      await page.goto(TRADER);
      // First answers are busy: placeholders, and neither a banner nor an error.
      await expect(placeholders(page).first()).toBeVisible({ timeout: 30000 });
      await expect(page.getByText(/busy/i)).toHaveCount(0);
      await expect(failed(page)).toHaveCount(0);
      // Not yet 5 s: nothing was asked again, so nothing can have arrived.
      await page.clock.fastForward(3_000);
      await expect(profileIn(page)).toHaveCount(0);
      await page.clock.fastForward(2_500); // 5 s: asked again, busy again
      await expect(failed(page)).toHaveCount(0);
      await page.clock.fastForward(10_500); // +10 s: served
      await expect(profileIn(page).first()).toBeVisible({ timeout: 20000 });
      await page.clock.fastForward(16_000);
      await expect(placeholders(page)).toHaveCount(0, { timeout: 20000 });
      await expect(failed(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
      await expect(page.getByText("Couldn't load data.")).toHaveCount(0);
    });

    test("when the retries run out the page is CopyDog's line and Retry, never a lasting placeholder; Retry loads it", async ({ page }) => {
      test.setTimeout(90000);
      await busy(page, "always:profile");
      await page.goto(TRADER);
      await expect(placeholders(page).first()).toBeVisible({ timeout: 30000 });
      for (const wait of [5_500, 10_500]) {
        await page.clock.fastForward(wait);
        await expect(failed(page)).toHaveCount(0);
        await page.waitForTimeout(500); // let the retried request answer before the next jump
      }
      await page.clock.fastForward(15_500);
      await expect(failed(page)).toBeVisible({ timeout: 20000 });
      await expect(placeholders(page)).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText("Busy");
      // The api is back: one click, the whole page.
      await page.evaluate(() => sessionStorage.removeItem("orbie:fixtures:trader-busy"));
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(profileIn(page).first()).toBeVisible({ timeout: 20000 });
      await expect(failed(page)).toHaveCount(0);
    });

    test("sections whose own requests never answer settle (no placeholder left) while the rest of the page shows", async ({ page }) => {
      test.setTimeout(90000);
      await busy(page, "always:portfolio,analytics,copy-score");
      await page.goto(TRADER);
      await expect(profileIn(page).first()).toBeVisible({ timeout: 30000 });
      await expect(placeholders(page).first()).toBeVisible();
      for (const wait of [5_500, 10_500, 15_500, 20_500]) await page.clock.fastForward(wait);
      await expect(placeholders(page)).toHaveCount(0, { timeout: 20000 });
      await expect(failed(page)).toHaveCount(0);
      await expect(page.getByText(/busy/i)).toHaveCount(0);
      // The trader's own data is all there.
      await expect(profileIn(page).first()).toBeVisible();
    });
  });
}
