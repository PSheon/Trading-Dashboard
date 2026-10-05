import { signIn, wcag } from "./helpers";
import { test, expect } from "@playwright/test";
for (const width of [1440, 375])
  test(`source evidence and import preview at ${width}px`, async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/en/admin/traders/lists");
    await signIn(page);
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
        await (await wcag(page))
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
    // The old 資料來源 page is now the overview's collection counts.
    await page.goto("/en/admin/data-sources");
    await expect(page).toHaveURL(/\/admin$/);
    const counts = page.getByRole("region", { name: "Collection counts" });
    await expect(counts.getByText("Official leaderboard addresses", { exact: true })).toBeVisible({ timeout: 20000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
test('malformed JSON rows are rejected before rendering the raw table',async({page,context,baseURL})=>{
 await context.addCookies([{name:'locale',value:'en',url:baseURL!}]);
 await page.goto('/en/admin/traders/lists');await signIn(page);
 await page.locator('input[type=file]').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('[null]')});
 await expect(page.getByText("Couldn't parse the file",{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Preview impact',exact:true})).toBeDisabled();
});
