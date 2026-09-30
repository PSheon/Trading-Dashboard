import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
for (const width of [1440, 375])
  test(`KOL overwrite and removal review at ${width}px`, async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/admin/kols");
    await page.getByRole("button", { name: "Demo login", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Preview KOL changes", exact: true }),
    ).toBeVisible();
    await page
      .locator("input[type=file]")
      .setInputFiles({
        name: "kols.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          "address,display_name\n0x" + "aa".repeat(20) + ",Changed name",
        ),
      });
    await page
      .getByRole("button", { name: "Preview KOL changes", exact: true })
      .click();
    await expect(
      page.getByText("Manual name", { exact: true }).last(),
    ).toBeVisible();
    await expect(page.getByText("Changed name", { exact: true })).toBeVisible();
    await page.getByLabel("Replace unlisted KOLs", { exact: true }).check();
    await expect(
      page.getByRole("button", { name: "Confirm KOL import", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Preview KOL changes", exact: true })
      .click();
    await expect(
      page.getByLabel("I confirm removal of 1 KOL entries.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Confirm KOL import", exact: true }),
    ).toBeDisabled();
    await page
      .getByLabel("I confirm removal of 1 KOL entries.", { exact: true })
      .check();
    await expect(
      page.getByRole("button", { name: "Confirm KOL import", exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.screenshot({
      path: `/tmp/orbie-kol-preview-${width}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Confirm KOL import", exact: true })
      .click();
    await expect(
      page.getByText("0 added, 1 updated, 1 removed", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Confirm KOL import", exact: true }),
    ).toBeDisabled();
  });
