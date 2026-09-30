import { test, expect } from "@playwright/test";

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});
test("anonymous admin gate, demo login and logout clear private UI", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/admin/users");
  await expect(page.getByRole("button", { name: "Demo login", exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.getByRole("button", { name: "Demo login", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Demo login", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test("public discovery navigates to a trader with activity without signing in", async ({ page }) => {
  const response = await page.goto("/explore");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  const trader = page.locator('a[href^="/trader/"]').first();
  await expect(trader).toBeVisible();
  await trader.click();
  await expect(page).toHaveURL(/\/trader\/0x/);
  await expect(page.getByRole("tablist")).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`trader analytics and trade ledger work at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/explore");
    await page.locator('a[href^="/trader/"]').first().click();
    await expect(page.getByTestId("trading-style")).not.toHaveText("—");
    await page.getByRole("tab", { name: "Performance", exact: true }).click();
    await expect(page.getByRole("tabpanel").getByText(/Funding read through/)).toBeVisible();
    await page.getByRole("tab", { name: "Trades", exact: true }).click();
    const trades = page.getByRole("tabpanel", { name: "Trades" });
    if (width < 640) {
      const card = trades.getByRole("list").getByRole("listitem").first();
      await expect(card).toContainText(/Long|Short/);
      await expect(card.getByRole("button", { name: "Share trade", exact: true })).toBeVisible();
    } else {
      await expect(trades.getByRole("table")).toBeVisible();
    }
    await expect(page.getByRole("tabpanel").getByText(/Funding read through/)).toBeVisible();
    expect(errors).toEqual([]);
  });
}
