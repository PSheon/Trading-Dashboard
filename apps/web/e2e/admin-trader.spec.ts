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
    await page
      .getByLabel("Hyperliquid address", { exact: true })
      .fill("0x" + "ab".repeat(20));
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
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
    await page
      .getByLabel("Hyperliquid address", { exact: true })
      .fill("0x" + "cd".repeat(20));
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Unlabelled address", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Research trader", { exact: true }),
    ).toHaveCount(0);
  });
