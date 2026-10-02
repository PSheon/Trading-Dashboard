import { expect, test } from "@playwright/test";

/** Review round 4, part 4: things a phone user ran into. */
test.beforeEach(async ({ context, baseURL, page }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await page.setViewportSize({ width: 390, height: 844 });
});

test("phone settings: back from a sub-view, then close, leaves settings (no loop)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Portfolio" }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/\/portfolio$/);
  await page.goto("/settings");
  const panel = page.getByRole("dialog", { name: "Settings" });
  await panel.getByRole("button", { name: /Language/ }).click();
  await expect(page).toHaveURL(/view=language/);
  await panel.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  // Once more, to be sure the two buttons don't alternate.
  await panel.getByRole("button", { name: /Language/ }).click();
  await panel.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).not.toHaveURL(/\/settings/);
});

test("phone settings and search keep focus inside while open", async ({ page }) => {
  await page.goto("/settings");
  const panel = page.getByRole("dialog", { name: "Settings" });
  await expect(panel).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }

  await page.goto("/");
  const open = page.getByRole("button", { name: "Search name, X handle or address" }).filter({ visible: true });
  await open.click();
  const search = page.getByRole("search");
  await expect(search.getByRole("combobox")).toBeFocused();
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(await search.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Search name, X handle or address" }).filter({ visible: true })).toBeFocused();
});

test("market icons load from this site and text fields are 16px on a touch screen", async ({ page, browser, baseURL }) => {
  await page.goto("/");
  const sources = await page.locator("img").evaluateAll((images) => images.map((image) => image.getAttribute("src") ?? ""));
  expect(sources.filter((src) => src.includes("hyperliquid.xyz"))).toEqual([]);

  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, baseURL });
  await touch.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  const phone = await touch.newPage();
  await phone.goto("/");
  await phone.getByRole("button", { name: "Search name, X handle or address" }).filter({ visible: true }).click();
  expect(await phone.getByRole("combobox").evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
  await touch.close();
});

test("a phone home card never cuts an address twice", async ({ page }) => {
  await page.goto("/");
  const names = await page.locator('a[href^="/trader/0x"]').filter({ visible: true }).evaluateAll((cards) => cards.map((card) => (card as HTMLElement).innerText));
  expect(names.length).toBeGreaterThan(3);
  for (const name of names) expect((name.match(/…/g) ?? []).length, name).toBeLessThanOrEqual(1);
});
