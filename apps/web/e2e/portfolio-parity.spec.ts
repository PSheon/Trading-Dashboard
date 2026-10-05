import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, shot, signIn } from "./helpers";

/** CopyDog's portfolio (desktop ≥ 1280: hero band with the chart, then the
 * COPYING / INSIGHTS / EXPOSURE card; phone: the same three tabs). */
test.describe("portfolio parity", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  });

  test("desktop: chart, today's PnL, legend, the three tabs and the copy comparison at 1440px", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/en/portfolio");
    await signIn(page);
    const chart = page.getByRole("region", { name: "Paper portfolio PnL history" });
    await expect(chart).toBeVisible();
    for (const w of ["24H", "7D", "30D", "All"]) await expect(chart.getByRole("radio", { name: new RegExp(`^${w}$`, "i") })).toBeVisible();
    await expect(chart.locator("svg").first()).toBeVisible();
    await chart.getByRole("radio", { name: "ROI" }).click();
    await expect(chart.getByText(/%$/).first()).toBeVisible();
    await expect(page.getByTestId("paper-today").filter({ visible: true })).toContainText("Today (UTC)");
    for (const label of ["Available", "Copied", "Unrealized P&L"]) await expect(page.getByText(label, { exact: true }).filter({ visible: true }).first()).toBeVisible();
    const copying = page.getByRole("tab", { name: /Copying\s*2/ }).filter({ visible: true });
    await expect(copying).toHaveAttribute("aria-selected", "true");
    // The equity-curve column draws each copy's curve, not "—".
    await expect(page.locator('[role="tabpanel"] svg[aria-hidden]').first()).toBeVisible();
    await shot(page, "portfolio-1440");

    await page.getByRole("tab", { name: "Insights" }).filter({ visible: true }).click();
    for (const text of ["Overview", "Invested", "Value", "Best Trades", "Traders"]) await expect(page.getByText(text, { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText("SOL", { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await page.getByRole("radio", { name: "Worst" }).click();
    await expect(page.getByText("Worst Trades", { exact: true })).toBeVisible();
    await shot(page, "portfolio-insights-1440");

    await page.getByRole("tab", { name: "Exposure" }).filter({ visible: true }).click();
    for (const text of ["Direction", "Leverage", "By Asset", "Notional"]) await expect(page.getByText(text, { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await page.getByRole("button", { expanded: false }).filter({ hasText: "BTC" }).first().click();
    await expect(page.getByRole("button", { expanded: true }).filter({ hasText: "BTC" })).toBeVisible();
    await shot(page, "portfolio-exposure-1440");
    await expectNoSidewaysScroll(page);

    // One copy: your copy vs the trader over the same window.
    await page.getByRole("tab", { name: /Copying/ }).filter({ visible: true }).click();
    await page.locator('[role="tabpanel"] button').filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/copy=\d+/);
    const compare = page.getByTestId("copy-compare").filter({ visible: true });
    await expect(compare).toContainText("Same period, since");
    const trader = page.getByRole("radio", { name: "Trader", exact: true }).filter({ visible: true });
    await trader.click();
    await expect(trader).toHaveAttribute("aria-checked", "true");
    await shot(page, "portfolio-copy-compare-1440");
  });

  test("phone: paper summary, the three tabs and the insights chart at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/en/portfolio");
    await signIn(page);
    await expect(page.getByTestId("paper-today").filter({ visible: true })).toBeVisible();
    await shot(page, "portfolio-390");
    await page.getByRole("tab", { name: "Insights" }).filter({ visible: true }).click();
    await expect(page.getByRole("region", { name: "Paper portfolio PnL history" }).filter({ visible: true })).toBeVisible();
    await expect(page.getByText("Best Trades", { exact: true }).filter({ visible: true })).toBeVisible();
    await shot(page, "portfolio-insights-390");
    await page.getByRole("tab", { name: "Exposure" }).filter({ visible: true }).click();
    await expect(page.getByText("By Asset", { exact: true }).filter({ visible: true })).toBeVisible();
    await shot(page, "portfolio-exposure-390");
    await expectNoSidewaysScroll(page);
  });
});

/** CopyDog's phone Activity panel (the portfolio's bell). */
test.describe("activity panel", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  });

  test("signed out it asks to sign in; signed in it lists copy fills, favorites' trades and wallet transfers at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/en/portfolio");
    await page.getByRole("button", { name: "Activity" }).filter({ visible: true }).click();
    const panel = page.getByRole("dialog", { name: /Activity/ });
    await expect(panel.getByText("Sign in for alerts")).toBeVisible();
    await panel.getByRole("button", { name: "Close" }).click();
    await signIn(page);
    await page.getByRole("button", { name: "Activity" }).filter({ visible: true }).click();
    for (const chip of ["Copies", "Following", "Deposits"]) await expect(panel.getByRole("tab", { name: chip })).toBeVisible();
    await expect(panel.getByText(/^Copy Long HYPE at/)).toBeVisible();
    await expect(panel.getByText(/^Close Long SOL at/)).toBeVisible();
    await expect(panel.getByText(/^via /).first()).toBeVisible();
    await shot(page, "activity-copies-390");
    await panel.getByRole("tab", { name: "Following" }).click();
    await expect(panel.getByRole("tabpanel")).toBeVisible();
    await shot(page, "activity-following-390");
    await panel.getByRole("tab", { name: "Deposits" }).click();
    await expect(panel.getByRole("tabpanel")).toBeVisible();
    await shot(page, "activity-deposits-390");
    await expectNoSidewaysScroll(page);
  });
});
