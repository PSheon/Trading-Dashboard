import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAccessible, expectNoSidewaysScroll, saveSettings, shot, signIn } from "./helpers";

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

/** The chips of a market list, in order. */
const chips = (list: Locator) => list.getByRole("listitem").filter({ has: list.page().getByRole("button", { name: /^Remove / }) });
const chipNames = async (list: Locator) => (await chips(list).allInnerTexts()).map((t) => t.trim());
const placed = (page: Page) => page.evaluate(() => new Promise((r) => setTimeout(r, 150)));

for (const width of [1440, 390]) {
  test(`settings: limits saved from one changes card; market lists edited as chips by keyboard; the env-moved knobs are read-only at ${width}px`, async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/settings");
    await signIn(page);
    const changes = page.getByRole("region", { name: "Changes on save" });
    await expect(changes).toContainText("Nothing changed yet.", { timeout: 20000 });
    // Gone from the form (Paul, 2026-10-05): retention, weights, pool size, featured, referral code.
    for (const gone of ["Data retention", "Target candidate pool size", "Performance reads: weight per minute", "Featured traders", "Referral code"]) {
      await expect(page.getByLabel(gone, { exact: true })).toHaveCount(0);
    }

    const general = page.locator("#general");
    const favorites = general.getByLabel("Favorites each user may keep");
    await expect(favorites).toHaveValue("");
    await favorites.fill("50");
    await expect(changes).toContainText("Favorites limit");
    await expect(changes).toContainText("— → 50");

    // 首頁市場: add a stock by keyboard from the exchange's list, move it first, remove one.
    const home = page.getByRole("list", { name: "Home page market chips" });
    const before = await chipNames(home);
    expect(before.length).toBeGreaterThan(3);
    await page.getByRole("button", { name: "Add to Home page market chips" }).click();
    const search = page.getByRole("combobox", { name: "Add to Home page market chips" });
    await expect(search).toBeFocused();
    await search.fill("aapl");
    await expect(page.getByRole("option", { name: /xyz:AAPL/ })).toContainText("Stock");
    await page.keyboard.press("Enter");
    await expect(page.getByText(`${before.length + 1} / 16`, { exact: true }).first()).toBeVisible();
    await expect(chips(home).last()).toContainText("AAPL");
    // A market already chosen is offered as 已選 and can't be picked again.
    await page.getByRole("button", { name: "Add to Home page market chips" }).click();
    await page.getByRole("combobox", { name: "Add to Home page market chips" }).fill("aapl");
    await expect(page.getByRole("option", { name: /xyz:AAPL/ })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    // Reorder with the keyboard: Home moves the focused chip first.
    await page.getByRole("button", { name: new RegExp(`^Move AAPL, ${before.length + 1} of`) }).focus();
    await page.keyboard.press("Home");
    await placed(page);
    expect((await chipNames(home))[0]).toContain("AAPL");
    await expect(page.getByRole("button", { name: /^Move AAPL, 1 of/ })).toBeFocused();
    await page.getByRole("button", { name: /^Move AAPL, 1 of/ }).press("ArrowRight");
    expect((await chipNames(home))[1]).toContain("AAPL");
    await chips(home).last().getByRole("button", { name: /^Remove / }).click();
    await expect(changes).toContainText("Home markets");
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, `admin-settings-${width}`);

    await saveSettings(page);
    await expect(changes.getByRole("status")).toContainText("Saved");
    await expect(favorites).toHaveValue("50");
    expect((await chipNames(home))[1]).toContain("AAPL");

    // 進階: the deployment's values, read-only.
    const advanced = page.getByRole("region", { name: /^Advanced/ });
    await expect(advanced).toContainText("Pool size 1000");
    await advanced.getByRole("button", { name: "Expand" }).click();
    await expect(advanced.getByText("RETENTION_SNAPSHOT_DAYS", { exact: true })).toBeVisible();
    await expect(advanced.getByRole("textbox")).toHaveCount(0);

    // 預設規則 lives in 通知 now.
    await page.locator("#notifications").getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Default rules" })).toBeVisible();
  });
}

test("the old default-rules page lands on the settings' notifications", async ({ page }) => {
  await page.goto("/admin/rules");
  await expect(page).toHaveURL(/\/admin\/settings#notifications$/);
});
