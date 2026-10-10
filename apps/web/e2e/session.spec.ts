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
  await page.getByRole("button", { name: "Logout", exact: true }).click();
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
  test(`account preferences animate, restore keyboard focus and respect reduced motion at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/en/settings?tab=referral&view=referral");
    await signIn(page);
    const trigger = page.getByRole("button", { name: "Account", exact: true }).filter({ visible: true }).first();
    await trigger.click();
    const menu = page.getByTestId("account-menu-card");
    const surface = page.locator(width < 768 ? ".account-menu-sheet" : ".account-menu-popover");
    await expect(menu).toBeVisible();
    expect(await surface.evaluate(el => getComputedStyle(el).animationName)).toBe(width < 768 ? "account-menu-up" : "account-menu-down");

    await menu.getByRole("button", { name: /^Language/ }).click();
    const panel = menu.locator('[data-account-panel="language"]');
    await expect(panel).toBeVisible();
    expect(await panel.evaluate(el => getComputedStyle(el).animationName)).toBe("account-menu-panel");
    await expect(panel.getByRole("radio", { name: "English", exact: true })).toBeChecked();
    await expect(panel.getByRole("button", { name: "Back", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu.getByRole("button", { name: /^Language/ })).toBeFocused();

    await menu.getByRole("button", { name: /^Theme/ }).click();
    const theme = menu.getByRole("radiogroup", { name: "Theme", exact: true });
    await theme.getByRole("radio", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await theme.getByRole("radio", { name: "System", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(menu.getByRole("button", { name: /^Theme/ })).toBeFocused();

    const logout = menu.getByRole("button", { name: "Logout", exact: true });
    await logout.hover();
    await expect.poll(() => logout.evaluate(el => {
      const probe = document.createElement("span");
      probe.style.color = "var(--destructive)";
      el.append(probe);
      const result = { actual: getComputedStyle(el).color, expected: getComputedStyle(probe).color };
      probe.remove();
      return result.actual === result.expected;
    })).toBe(true);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    await page.emulateMedia({ reducedMotion: "reduce" });
    await trigger.click();
    await expect(menu).toBeVisible();
    expect(await surface.evaluate(el => getComputedStyle(el).animationName)).toBe("none");
    await menu.getByRole("button", { name: /^Language/ }).click();
    expect(await menu.locator('[data-account-panel="language"]').evaluate(el => getComputedStyle(el).animationName)).toBe("none");
  });
}

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
