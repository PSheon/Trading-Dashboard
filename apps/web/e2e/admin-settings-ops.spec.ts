import { chooseOption, saveSettings, signIn, wcag } from "./helpers";
import { expect, test } from "@playwright/test";
for (const width of [1440, 375]) {
  test(`pending changes are listed before a save, and the read-only audit log finds them at ${width}px`, async ({ page, context, baseURL }) => {
    test.setTimeout(90000);
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/admin/settings");
    await signIn(page);
    const changes = page.getByRole("region", { name: "Changes on save" });
    await expect(changes).toContainText("Nothing changed yet.", { timeout: 20000 });
    await page.getByLabel("Traders each user can turn alerts on for", { exact: true }).fill("5");
    await expect(changes).toContainText("3 → 5");
    await saveSettings(page);
    await expect(changes.getByRole("status")).toContainText("Saved");
    expect((await (await wcag(page)).analyze()).violations).toEqual([]);
    await page.goto("/admin/users/audit");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
    await chooseOption(page, page.getByLabel("Event", { exact: true }), "job.retry");
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await expect(page.getByText("No matching records", { exact: true })).toBeVisible();
    await chooseOption(page, page.getByLabel("Event", { exact: true }), "settings.update");
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await page.getByRole("button", { name: "View changes", exact: true }).first().click();
    await expect(page.getByText('"maxAlertTraders": 5', { exact: false }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await (await wcag(page)).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR ?? "/tmp"}/orbie-admin-audit-${width}.png`, fullPage: true });
  });
}
