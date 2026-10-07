import { expect, test, type Page } from "@playwright/test";

/** The trader's account value: drawn only once the profile is in (the
 * loading outline shows the label, not the figure). */
const profileIn = (page: Page) => page.getByTestId("account-value").filter({ visible: true });

const UNKNOWN = `0x${"0".repeat(36)}dead`;

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

/** CopyDog's search: Enter opens the trader page for the typed text as it
 * stands; a lit row (↑/↓) opens that trader. No data is the 404 page. */
for (const width of [1440, 390]) {
  test(`search Enter opens the typed trader, or the 404, at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/en");
    const open = async () => {
      // Phones show the search icon until it's tapped.
      if (width < 768) await page.getByRole("button", { name: "Search name, X handle or address" }).click();
      return page.getByRole("combobox", { name: "Search name, X handle or address" });
    };
    const notFound = page.getByRole("heading", { name: "404", exact: true });

    // A known address: its trader page.
    const first = await page.locator('a[href*="/trader/0x"]').first().getAttribute("href");
    const known = first!.split("/").pop()!;
    let box = await open();
    await box.fill(known.toUpperCase().replace("0X", "0x"));
    await box.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/trader/${known}$`), { timeout: 30000 });
    await expect(notFound).toHaveCount(0);
    await expect(profileIn(page).first()).toBeVisible({ timeout: 20000 });

    // Text that is no address: the 404, without picking the first match.
    await page.goto("/en");
    box = await open();
    await box.fill("zz garbage");
    await box.press("Enter");
    await expect(page).toHaveURL(/\/trader\/zz%20garbage$/);
    await expect(notFound).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/en");

    // An address Hyperliquid has nothing for: the 404 once the page has asked.
    await page.goto("/en");
    box = await open();
    await box.fill(UNKNOWN);
    await box.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/trader/${UNKNOWN}$`));
    await expect(notFound).toBeVisible();

    // A lit row opens that trader (desktop dropdown).
    if (width >= 768) {
      await page.goto("/en");
      box = await open();
      await box.fill(known.slice(0, 6));
      const option = page.getByRole("option").first();
      await expect(option).toBeVisible();
      await box.press("ArrowDown");
      await box.press("Enter");
      await expect(page).toHaveURL(/\/trader\/0x[0-9a-f]{40}$/);
      await expect(notFound).toHaveCount(0);
    }
  });
}

test("the full leaderboard is a lab page; explore no longer links to it", async ({ page }) => {
  expect((await page.goto("/en/explore/all"))?.status()).toBe(404);
  await page.goto("/en/explore");
  await expect(page.locator('a[href*="/trader/"]').first()).toBeAttached();
  await expect(page.locator('a[href*="explore/all"]')).toHaveCount(0);
  await page.goto("/en/dev/explore/all");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
