import { firstTraderLink, openFirstTrader, signIn } from "./helpers";
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});
test("anonymous admin gate, demo login and logout clear private UI", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/en/admin/users");
  await expect(page.getByRole("button", { name: "Demo login", exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await signIn(page);
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("menuitem", { name: "Logout", exact: true }).click();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Demo login", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test("public discovery navigates to a trader with activity without signing in", async ({ page }) => {
  const response = await page.goto("/en/explore");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  await expect(firstTraderLink(page)).toBeVisible();
  await openFirstTrader(page);
  await expect(page.getByRole("tablist", { name: "Trading activity" })).toBeVisible();
});

for (const width of [1440, 390]) {
  test(`trader analytics and trade ledger work at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/en/explore");
    await openFirstTrader(page);
    const mobile = width < 768;
    // One tab row on desktop and phones: 持倉 / 洞察 / 表現 / 交易 / 動態.
    const activity = page.getByRole("tablist", { name: "Trading activity" });
    await expect(activity.getByRole("tab")).toHaveText(["Positions", "Insights", "Performance", "Trades", "Activity"]);
    await expect(page.getByRole("button", { name: "Live activity" })).toHaveCount(0);
    const select = (name: string) => activity.getByRole("tab", { name, exact: true }).click();
    // Insights shows the trading style on both; the desktop profile card too.
    await select("Insights");
    await expect(page.getByRole("heading", { name: "Trader Profile", exact: true })).toBeVisible();
    if (!mobile) await expect(page.getByTestId("trading-style").filter({ visible: true })).not.toHaveText("—");
    await select("Performance");
    await expect(page.getByRole("radiogroup", { name: "Performance", exact: true }).getByRole("radio", { name: "Best", exact: true })).toBeChecked();
    if (mobile) await expect(page.getByRole("main").getByRole("list").getByRole("listitem").first()).toContainText(/Long|Short/);
    else await expect(page.getByRole("tabpanel", { name: "Performance" }).getByRole("row").nth(1)).toContainText(/Long|Short/);
    await select("Trades");
    if (mobile) {
      const card = page.getByRole("main").getByRole("list").getByRole("listitem").first();
      await expect(card).toContainText(/Long|Short/);
      await expect(card.getByRole("button", { name: "Share trade", exact: true })).toBeVisible();
    } else {
      const row = page.getByRole("tabpanel", { name: "Trades" }).getByRole("table").getByRole("row").nth(1);
      await expect(row).toContainText(/Long|Short/);
      await expect(row.getByRole("button", { name: "Share trade", exact: true })).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}
