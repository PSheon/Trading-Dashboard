import { expect, test } from "@playwright/test";
import { expectAccessible, expectNoSidewaysScroll, shot, signIn } from "./helpers";

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

/**
 * 總覽 (2026-10-05): the KPIs, revenue (the old 收入 page), service status,
 * freshness and queues (the old 系統 page), the deployment's switches and
 * tuning read-only, and the collection counts (the old 資料來源 page).
 */
for (const width of [1440, 390]) {
  test(`the overview carries revenue, status, queues, the deployment and the counts at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/en/admin");
    await signIn(page);
    await expect(page.getByText("Watched traders", { exact: true })).toBeVisible({ timeout: 20000 });

    const revenue = page.getByRole("region", { name: "Revenue" });
    await expect(revenue.getByRole("radiogroup")).toBeVisible();
    await revenue.getByRole("radio", { name: "7d" }).click();
    await expect(revenue.getByRole("radio", { name: "7d" })).toHaveAttribute("aria-checked", "true");

    const status = page.getByRole("region", { name: "Service status" });
    await expect(status.getByText(/Standby/)).toBeVisible();
    await expect(status.getByText("180 / 240", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Data freshness" })).toContainText("Leaderboard import");
    await expect(page.getByRole("region", { name: "Queues & jobs" })).toContainText("Copy signal backlog");

    // Read-only, from the environment: the worker's switches and the tuning that left the settings.
    const deploy = page.getByRole("region", { name: "Deployment (read-only, from env)" });
    await expect(deploy).toContainText("Copy mode · paper");
    await expect(deploy).toContainText("Weight caps · 100 / 240 / 120 / 120 / 150");
    await expect(deploy).toContainText("pool 1000");
    await expect(deploy.getByRole("button")).toHaveCount(0);
    await expect(deploy.getByRole("textbox")).toHaveCount(0);

    await expect(page.getByRole("region", { name: "Collection counts" }).getByText("Official leaderboard addresses", { exact: true })).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, `admin-overview-${width}`);

    // The old system page's detail, folded: the retention run per table.
    await page.getByRole("button", { name: "System details" }).click();
    const retention = page.getByTestId("retention-panel");
    await expect(retention.getByText("Complete", { exact: true })).toBeVisible();
    await expect(retention.getByText("15,604", { exact: true })).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
}

test("the old overview pages land on the overview", async ({ page }) => {
  for (const from of ["/admin/system", "/admin/revenue", "/admin/data-sources", "/admin/activity", "/status"]) {
    await page.goto(from);
    await expect(page).toHaveURL(/\/admin$/);
  }
});
