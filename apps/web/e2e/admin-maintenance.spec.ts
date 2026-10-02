import { expect, test } from "@playwright/test";
import { expectAccessible, expectNoSidewaysScroll, shot, signIn } from "./helpers";

// The viewer's own zone must not matter: every time on the site is UTC.
test.use({ timezoneId: "Asia/Taipei" });

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

for (const width of [1440, 390]) {
  test(`maintenance mode is switched on with a confirmation and the notice shows on every page at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/settings");
    await signIn(page);
    const general = page.locator("#general");
    const toggle = general.getByRole("switch", { name: "Turn maintenance mode on" });
    await expect(toggle).toBeVisible({ timeout: 20000 });
    const notice = page.getByRole("status").filter({ hasText: "Maintenance in progress" });
    await expect(notice).toHaveCount(0);

    await toggle.click();
    await general.getByLabel("Notice text (English, optional)").fill("Database upgrade in progress.");
    const ends = new Date(Date.now() + 2 * 3_600_000);
    // The field is typed in UTC and says so.
    const utc = ends.toISOString().slice(0, 16);
    await expect(general.getByText("Expected end (optional, shown to visitors) (UTC)", { exact: true })).toBeVisible();
    await general.getByLabel("Expected end (optional, shown to visitors)").fill(utc);
    await general.getByRole("button", { name: "Save section", exact: true }).click();
    // Nothing is saved until the confirmation.
    const dialog = page.getByRole("dialog", { name: "Turn maintenance mode on?" });
    await expect(dialog).toContainText("refused at once");
    await expect(notice).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    await general.getByRole("button", { name: "Save section", exact: true }).click();
    await dialog.getByRole("button", { name: "Confirm and save", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Database upgrade in progress.");
    await expect(notice).toContainText("Expected back around");
    // The same UTC clock time comes back, labelled, in a browser set to Taipei.
    await expect(notice).toContainText(`${utc.slice(11)} UTC`);
    await expect(general.getByText("Maintenance mode is on", { exact: true })).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, `admin-maintenance-settings-${width}`);

    // Site-wide: the notice is on a public page too (client-side navigation keeps the fixture state).
    await page.getByRole("link", { name: "Home" }).filter({ visible: true }).first().click();
    // The dev server may still be compiling the home page.
    await expect(page).toHaveURL(/\/$/, { timeout: 20000 });
    await expect(notice).toBeVisible();
    await expectNoSidewaysScroll(page);
    await shot(page, `maintenance-home-${width}`);

    // Editing the text while it stays on asks nothing; switching it off asks again.
    await page.goBack();
    await expect(toggle).toBeVisible({ timeout: 20000 });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await general.getByRole("button", { name: "Save section", exact: true }).click();
    await page.getByRole("dialog", { name: "Turn maintenance mode off?" }).getByRole("button", { name: "Confirm and save", exact: true }).click();
    await expect(notice).toHaveCount(0);
  });
}
