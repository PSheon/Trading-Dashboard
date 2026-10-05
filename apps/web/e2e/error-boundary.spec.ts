import { expect, test } from "@playwright/test";

/** A route that throws while rendering shows the error boundary — one
 * line, Retry, the way home — at both widths. */
for (const width of [1440, 390]) {
  test(`a crashed route shows the error boundary at ${width}px`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/en/dev/crash");
    const alert = page.getByRole("alert").filter({ hasText: "Failed to load" });
    await expect(alert.getByRole("heading", { level: 1, name: "Failed to load" })).toBeVisible();
    await expect(alert.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(alert).not.toContainText("on purpose");
    // (The lab draws no shell; on a user page the boundary sits inside it.)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await alert.getByRole("link", { name: "Back to Leaderboard" }).click();
    await expect(page).toHaveURL(/\/en$/);
    await expect(page.getByRole("alert").filter({ hasText: "Failed to load" })).toHaveCount(0);
  });
}
