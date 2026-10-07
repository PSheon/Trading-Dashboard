import { expect, test, type Locator } from "@playwright/test";
import { signIn } from "./helpers";

/** Review round 4, part 4: things a phone user ran into. */
/** Opens the phone's full-screen search. A tap that lands before the page
 * has hydrated does nothing (CI's dev server is slow to hydrate), so it
 * taps again until the field is there. */
async function openPhoneSearch(button: Locator, field: Locator) {
  await expect(async () => {
    if (!(await field.isVisible())) await button.click();
    await expect(field).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 25_000 });
}

test.beforeEach(async ({ context, baseURL, page }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await page.setViewportSize({ width: 390, height: 844 });
});

test("phone settings: back from a sub-view, then back to the portfolio (no loop)", async ({ page }) => {
  await page.goto("/en");
  // The Portfolio tab is there once signed in.
  await signIn(page);
  await page.getByRole("link", { name: "Portfolio" }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/portfolio$/);
  await page.goto("/en/settings");
  const panel = page.getByTestId("phone-settings").filter({ visible: true });
  await panel.getByRole("button", { name: /Language/ }).click();
  await expect(page).toHaveURL(/view=language/);
  await panel.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  // Returning from another sub-view also leaves the root reachable.
  await panel.getByRole("button", { name: /Language/ }).click();
  await panel.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await panel.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/portfolio$/);
});

test("phone settings keeps navigation visible; search keeps focus inside while open", async ({ page }) => {
  await page.goto("/en/settings");
  const panel = page.getByTestId("phone-settings").filter({ visible: true });
  await expect(panel).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

  await page.goto("/en");
  const open = page.getByRole("button", { name: "Search name, X handle or address" }).filter({ visible: true });
  const search = page.getByRole("search");
  // A tap before the page has hydrated does nothing: tap until it opens.
  await openPhoneSearch(open, search.getByRole("combobox"));
  await expect(search.getByRole("combobox")).toBeFocused();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(await search.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Search name, X handle or address" }).filter({ visible: true })).toBeFocused();
});

test("market icons load from this site and text fields are 16px on a touch screen", async ({ page, browser, baseURL }) => {
  await page.goto("/en");
  const sources = await page.locator("img").evaluateAll((images) => images.map((image) => image.getAttribute("src") ?? ""));
  expect(sources.filter((src) => src.includes("hyperliquid.xyz"))).toEqual([]);

  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, baseURL });
  await touch.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  const phone = await touch.newPage();
  await phone.goto("/en");
  await openPhoneSearch(phone.getByRole("button", { name: "Search name, X handle or address" }).filter({ visible: true }), phone.getByRole("combobox"));
  expect(await phone.getByRole("combobox").evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
  await touch.close();
});

test("a phone home card never cuts an address twice", async ({ page }) => {
  await page.goto("/en");
  const cards = page.locator('a[href*="/trader/0x"]').filter({ visible: true });
  // The cards fill in after the first paint; read them once they are there.
  await expect(cards.nth(3)).toBeVisible();
  const names = await cards.evaluateAll((cards) => cards.map((card) => (card as HTMLElement).innerText));
  expect(names.length).toBeGreaterThan(3);
  for (const name of names) expect((name.match(/…/g) ?? []).length, name).toBeLessThanOrEqual(1);
});
