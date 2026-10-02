import { expect, test } from "@playwright/test";
import { expectAccessible, expectNoSidewaysScroll, shot, signIn } from "./helpers";

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

/** Data retention (review findings 3 and 20): the periods are settings, and
 * the system page reports the job's last run. */
for (const width of [1440, 390]) {
  test(`retention periods are settings with the policy's defaults, and a change is saved, at ${width}px`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/settings");
    await signIn(page);
    const group = page.locator("#retention-settings");
    await expect(group.getByRole("heading", { name: "Data retention", exact: true })).toBeVisible({ timeout: 20000 });
    await expect(group.getByRole("switch", { name: "Delete data older than these periods" })).toHaveAttribute("aria-checked", "true");
    const fields: Array<[string, string]> = [
      ["Position and equity snapshots (days)", "90"],
      ["Admin audit log (days)", "365"],
      ["Account-deletion records (days)", "365"],
      ["Finished queue rows (days)", "30"],
      ["Alert delivery records (days)", "30"],
    ];
    for (const [label, value] of fields) await expect(group.getByLabel(label, { exact: true })).toHaveValue(value);
    await expect(group).toContainText("privacy policy");

    await group.getByLabel("Position and equity snapshots (days)", { exact: true }).fill("120");
    const general = page.locator("#general");
    await general.getByRole("button", { name: "Save section", exact: true }).click();
    await expect(general.getByText("Data retention", { exact: true }).first()).toBeVisible();
    await expect(general.getByText("Saved", { exact: true })).toBeVisible();
    await expect(group.getByLabel("Position and equity snapshots (days)", { exact: true })).toHaveValue("120");
    await expect(general.getByRole("alert")).toHaveCount(0);
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, `admin-retention-settings-${width}`);
  });

  test(`the system page shows the retention job's last run and rows removed per table at ${width}px`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/system");
    await signIn(page);
    const panel = page.getByTestId("retention-panel");
    await expect(panel.getByRole("heading", { name: "Data retention", exact: true })).toBeVisible({ timeout: 20000 });
    await expect(panel.getByText("Complete", { exact: true })).toBeVisible();
    // Times are UTC.
    await expect(panel.getByText("10/01/2026, 18:07", { exact: true }).first()).toBeVisible();
    for (const [table, rows] of [["Position snapshots", "15,604"], ["Equity snapshots", "4,147"], ["Finished signal evaluations", "1,689"], ["Alert delivery records", "198"], ["Account-deletion records", "0"]]) {
      const row = panel.locator("dl > div").filter({ hasText: table });
      await expect(row.locator("dd")).toHaveText(rows);
    }
    await expectNoSidewaysScroll(page);
    await panel.scrollIntoViewIfNeeded();
    await shot(page, `admin-retention-system-${width}`);
  });
}
