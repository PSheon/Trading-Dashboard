import { signIn, wcag, chooseOption } from "./helpers";
import { expect, test } from "@playwright/test";
for (const width of [1440, 375]) {
  test(`settings impact and read-only audit work at ${width}px`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/admin/settings");
    await signIn(page);
    await page.getByLabel("Target candidate pool size", { exact: true }).fill("500");
    await page.getByLabel("Pool weight budget per minute", { exact: true }).fill("0");
    await page.getByLabel("Crypto boards (display order)", { exact: true }).fill("BTC, ETH");
    await expect(page.getByRole("region", { name: "Changes on save" })).toContainText("500");
    await expect(page.getByRole("region", { name: "Changes on save" })).toContainText("1000");
    await page.locator("#discovery").getByRole("button", { name: "Save section", exact: true }).click();
    await expect(page.getByRole("region", { name: "Changes on save" })).toHaveCount(0);
    expect((await (await wcag(page)).analyze()).violations).toEqual([]);
    await page.goto("/admin/audit");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
    await chooseOption(page, page.getByLabel("Event", { exact: true }), "job.retry");
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await expect(page.getByText("No matching records", { exact: true })).toBeVisible();
    await chooseOption(page, page.getByLabel("Event", { exact: true }), "settings.update");
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await page.getByText("View changes", { exact: true }).first().click();
    await expect(page.getByText('"candidatePoolSize": 500', { exact: false }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await (await wcag(page)).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `/tmp/orbie-admin-audit-${width}.png`, fullPage: true });
  });
}
