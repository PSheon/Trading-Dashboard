import { expect, test, type Locator } from "@playwright/test";
import { expectAccessible } from "./helpers";

/** The list is placed (and focuses its checked item) once its entrance has
 * run; keys pressed before that would race the placement, as no person does. */
const placed = async (list: Locator) => {
  await list.evaluate((el) => Promise.all((el.closest("[data-slot=select-content]") ?? el).getAnimations({ subtree: true }).map((a) => a.finished)));
  await list.page().waitForTimeout(150);
};

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

// The shared Select (components/ui/select): a combobox trigger whose list
// is reached and used with the keyboard alone.
test("explore's sort pill opens, moves and picks with the keyboard at 1440", async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/explore");
  const sort = page.getByRole("combobox", { name: "Sort", exact: true });
  await expect(sort).toBeVisible({ timeout: 20000 });
  const before = (await sort.innerText()).trim();
  expect(await sort.evaluate((el) => el.getBoundingClientRect().height)).toBe(44);
  await sort.focus();
  await page.keyboard.press("Enter");
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await placed(list);
  // The current choice is checked and has focus.
  await expect(list.getByRole("option", { selected: true })).toHaveText(before);
  await expect(list.getByRole("option", { selected: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const next = (await page.locator('[role="option"]:focus').innerText()).trim();
  expect(next).not.toBe(before);
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(sort).toHaveText(next);
  await expect(sort).toBeFocused();
  // Escape closes without changing the choice.
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await placed(page.getByRole("listbox"));
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(sort).toHaveText(next);
  await expectAccessible(page);
});

test("the full leaderboard's value filter works by keyboard and fits a 390 px phone", async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dev/explore/all");
  const tier = page.getByRole("combobox", { name: "Min account value", exact: true });
  await expect(tier).toBeVisible({ timeout: 20000 });
  const before = (await tier.innerText()).trim();
  await tier.focus();
  await page.keyboard.press("ArrowDown");
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await placed(list);
  const box = await list.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await expect(list.getByRole("option", { selected: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  expect((await tier.innerText()).trim()).not.toBe(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
