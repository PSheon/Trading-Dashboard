import { signIn, wcag } from "./helpers";
import { expect, test } from "@playwright/test";
for (const width of [1440, 375])
  test(`admin trader evidence at ${width}px`, async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/admin/traders");
    await signIn(page);
    // The diagnosis opens from the 交易員資料 tab's search, in a drawer.
    const search = page.getByRole("searchbox", { name: "Diagnose an address" }).or(page.getByLabel("Diagnose an address", { exact: true }));
    await search.fill("0x" + "ab".repeat(20));
    await search.press("Enter");
    await expect(page).toHaveURL(/address=0x(ab){20}/);
    const drawer = page.getByRole("dialog");
    await expect(
      page.getByRole("heading", { name: "Research trader", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No watcher record", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Recorded refresh failure", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Historical imports do not establish current source membership.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Not recorded", { exact: true }).first(),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await (await wcag(page))
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: `/tmp/orbie-admin-trader-${width}.png`,
      fullPage: true,
    });
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await search.fill("0x" + "cd".repeat(20));
    await search.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Unlabelled address", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Research trader", { exact: true }),
    ).toHaveCount(0);
  });
