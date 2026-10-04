import { expect, test } from "@playwright/test";
import { expectAccessible, expectNoSidewaysScroll, shot, signIn } from "./helpers";

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

for (const width of [1440, 390]) {
  test(`the system page shows the deployment switches read-only at ${width}px`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/system");
    await signIn(page);
    const panel = page.getByRole("region", { name: "Deployment switches (read-only)" });
    await expect(panel).toBeVisible({ timeout: 20000 });
    for (const name of ["IS_WORKER", "COPY_TRADING_MODE", "HYPERLIQUID_NETWORK", "TELEGRAM_DRY_RUN", "S3_ARCHIVE_ENABLED", "S3_ARCHIVE_MAX_DAILY_USD", "MAX_FAVORITES_PER_USER"]) {
      await expect(panel.getByText(name, { exact: true })).toBeVisible();
    }
    const copyMode = panel.getByRole("row").filter({ hasText: "COPY_TRADING_MODE" });
    await expect(copyMode.getByText("paper", { exact: true })).toHaveCount(2);
    // The api and the worker differ here: the ingest runs in the worker.
    const ingest = panel.getByRole("row").filter({ hasText: "S3_ARCHIVE_ENABLED" });
    await expect(ingest.getByText("Off", { exact: true })).toBeVisible();
    await expect(ingest.getByText("On", { exact: true })).toBeVisible();
    await expect(panel.getByText("Unknown (the worker did not report)", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button")).toHaveCount(0);
    await expect(panel.getByRole("textbox")).toHaveCount(0);
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, `admin-system-switches-${width}`);
  });

  test(`the settings form edits the favorites limit and the three weight caps at ${width}px`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/settings");
    await signIn(page);
    const general = page.locator("#general");
    const favorites = general.getByLabel("Favorites each user may keep");
    await expect(favorites).toHaveValue("", { timeout: 20000 });
    await favorites.fill("50");
    await expect(general.getByText("Favorites limit", { exact: true })).toBeVisible();
    await general.getByRole("button", { name: "Save section", exact: true }).click();
    await expect(general.getByText("Saved", { exact: true })).toBeVisible();
    await expect(favorites).toHaveValue("50");
    // Emptied again: back to the deployment default.
    await favorites.fill("");
    await general.getByRole("button", { name: "Save section", exact: true }).click();
    await expect(general.getByText("Saved", { exact: true })).toBeVisible();
    await expect(favorites).toHaveValue("");

    const discovery = page.locator("#discovery");
    const fields = [["Performance reads: weight per minute", "240", "300"], ["Fill-history job: weight per minute", "120", "90"], ["Backfill job: weight per minute", "120", "0"]];
    for (const [label, before, after] of fields) {
      await expect(discovery.getByLabel(label)).toHaveValue(before);
      await discovery.getByLabel(label).fill(after);
    }
    await discovery.getByLabel("Performance reads: weight per minute").fill("601");
    // Over the 600 cap: the browser refuses to submit the form.
    expect(await discovery.getByLabel("Performance reads: weight per minute").evaluate((el: HTMLInputElement) => el.checkValidity())).toBe(false);
    await discovery.getByRole("button", { name: "Save section", exact: true }).click();
    await expect(discovery.getByText("Unsaved changes", { exact: false })).toBeVisible();
    await discovery.getByLabel("Performance reads: weight per minute").fill("300");
    await discovery.getByRole("button", { name: "Save section", exact: true }).click();
    await expect(discovery.getByText("Saved", { exact: true })).toBeVisible();
    for (const [label, , after] of fields) await expect(discovery.getByLabel(label)).toHaveValue(after);
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, `admin-settings-limits-${width}`);
  });
}
