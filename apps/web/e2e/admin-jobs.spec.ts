import { signIn, wcag, chooseOption } from "./helpers";
import { expect, test } from "@playwright/test";
for (const width of [1440, 375]) {
  test(`jobs paginate, filter and requeue without claiming completion at ${width}px`, async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/en/admin/traders/jobs");
    await signIn(page);
    await expect(
      page.getByRole("heading", { name: "Backfill jobs", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(page.getByText("Page 1", { exact: true })).toBeVisible();
    await chooseOption(page, page
      .getByRole("combobox", { name: "Job status" }), "failed");
    await page
      .getByRole("button", { name: "Requeue job #30", exact: true })
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Job requeued. It has not finished yet." }),
    ).toBeVisible();
    await expect(
      page.getByText("No jobs match this filter.", { exact: true }),
    ).toBeVisible();
    await chooseOption(page, page
      .getByRole("combobox", { name: "Job status" }), "pending");
    await expect(
      page.getByRole("main").locator("span:not([data-slot]):not(button span)").filter({ hasText: /^Queued$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Requeue job #30", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const audit = await (await wcag(page))
      .analyze();
    expect(
      audit.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
    await page.screenshot({
      path: `/tmp/orbie-admin-jobs-${width}.png`,
      fullPage: true,
    });
  });
}
