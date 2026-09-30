import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
for (const width of [1440, 375]) {
  test(`monitoring separates standby and unknown budgets at ${width}px`, async ({page, context, baseURL}) => {
    await context.addCookies([{name: "locale", value: "en", url: baseURL!}]);
    await page.setViewportSize({width, height: 1000});
    await page.goto("/admin/system");
    await page.getByRole("button", {name: "Demo login", exact: true}).click();
    await expect(page.getByRole("heading", {name: "System monitoring", exact: true})).toBeVisible();
    await expect(page.getByText("Standby", {exact: true})).toBeVisible();
    await expect(page.getByText(/Connected ·/)).toHaveCount(0);
    await expect(page.getByText("824 / 1000", {exact: true})).toBeVisible();
    await page.getByRole("button", {name: "Refresh", exact: true}).click();
    await expect(page.getByRole("button", {name: "Refresh", exact: true})).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const audit = await new AxeBuilder({page}).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(audit.violations.map(v => ({id: v.id, nodes: v.nodes.map(n => n.target)}))).toEqual([]);
    await page.screenshot({path: `/tmp/orbie-admin-monitoring-${width}.png`, fullPage: true});
  });
}
