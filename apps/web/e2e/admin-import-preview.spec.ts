import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
for (const width of [1440, 375])
  test(`source evidence and import preview at ${width}px`, async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/admin/lists");
    await page.getByRole("button", { name: "Demo login", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Preview impact", exact: true }),
    ).toBeVisible();
    const file = (rows: unknown[]) => ({
      name: "review.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(rows)),
    });
    await page
      .locator("input[type=file]")
      .setInputFiles(file([{ address: "bad", rank: 1 }]));
    await page
      .getByRole("button", { name: "Preview impact", exact: true })
      .click();
    await expect(
      page.getByText("Invalid row 1: invalid Ethereum address", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Confirm import", exact: true }),
    ).toBeDisabled();
    await page.locator("input[type=file]").setInputFiles(
      file([
        { address: "0x" + "11".repeat(20), rank: 2 },
        { address: "0x" + "11".repeat(20), rank: 1 },
      ]),
    );
    await expect(
      page.getByRole("button", { name: "Confirm import", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Preview impact", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Confirm import", exact: true }),
    ).toBeEnabled();
    await page.getByLabel("Import source", { exact: true }).fill("manual");
    await expect(
      page.getByRole("button", { name: "Confirm import", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Preview impact", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Confirm import", exact: true }),
    ).toBeEnabled();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`/tmp/orbie-import-preview-${width}.png`,fullPage:true});
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page
      .getByRole("button", { name: "Confirm import", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Confirm import", exact: true }),
    ).toBeDisabled();
    await expect(page.getByText(/Imported list #\d+: 1 items, 1 new addresses\./)).toBeVisible();
    await page.goto("/admin/data-sources");
    await expect(
      page.getByRole("heading", { name: "Data sources", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading",{name:"Official leaderboard addresses",exact:true})).toBeVisible();
    await expect(
      page.getByText(
        "Sets overlap; do not add these counts or treat them as live subscriptions.",
        { exact: true },
      ),
    ).toBeVisible();
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
      path: `/tmp/orbie-data-sources-${width}.png`,
      fullPage: true,
    });
  });
test('malformed JSON rows are rejected before rendering the raw table',async({page,context,baseURL})=>{
 await context.addCookies([{name:'locale',value:'en',url:baseURL!}]);
 await page.goto('/admin/lists');await page.getByRole('button',{name:'Demo login',exact:true}).click();
 await page.locator('input[type=file]').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('[null]')});
 await expect(page.getByText("Couldn't parse the file",{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Preview impact',exact:true})).toBeDisabled();
});
