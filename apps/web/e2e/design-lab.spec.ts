import { wcag } from "./helpers";
import { expect, test } from "@playwright/test";

for (const width of [1440, 375]) {
  test(`design versions keep working discovery and fit at ${width}px`, async ({ page, context, baseURL }) => {
    test.setTimeout(90000);
    await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
    await page.setViewportSize({ width, height: 1000 });
    for (const concept of ["wealth", "aero", "edge"]) {
      await page.goto(`/dev/${concept}`);
      const firstTrader = page.locator('a[href^="/trader/"]:visible').first();
      await expect(firstTrader).toBeVisible();
      const originalTrader = await firstTrader.getAttribute("href");
      await page.getByRole("combobox", { name: "Sort traders" }).selectOption("roi");
      await expect(firstTrader).not.toHaveAttribute("href", originalTrader!);
      await page.getByRole("combobox", { name: "Sort traders" }).selectOption("copyScore");
      await expect(page.locator("#calc-amount")).toBeVisible();
      await expect(page.locator('a[href^="/trader/"]')).toHaveCount(7);
      const result = page.locator('[aria-live="polite"]').filter({ hasText: "$" });
      const before = await result.innerText();
      await page.locator("#calc-amount").fill("2500");
      await expect(result).not.toHaveText(before);
      await page.getByRole("button", { name: "$5,000", exact: true }).click();
      await expect(page.locator("#calc-amount")).toHaveValue("5,000");
      const selectedResult = await result.innerText();
      await page.getByRole("combobox", { name: "Trader", exact: true }).selectOption({ index: 1 });
      await expect(result).not.toHaveText(selectedResult);
      await page.getByRole("button", { name: "Featured KOLs", exact: true }).click();
      await expect(page.getByRole("button", { name: "Featured KOLs", exact: true })).toHaveAttribute("aria-pressed", "true");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const accessibility = await (await wcag(page)).analyze();
      expect.soft(accessibility.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), `${concept} accessibility`).toEqual([]);
    }
    await page.getByRole("link", { name: "BTC", exact: true }).click();
    await expect(page).toHaveURL(/\/dev\/edge\/explore\?.*board=BTC/);
    await expect(page.locator('a[href^="/trader/"]:visible').first()).toBeVisible();
    await page.getByRole("navigation", { name: "Design versions" }).getByRole("link", { name: /Aero/ }).click();
    await expect(page).toHaveURL(/\/dev\/aero\/explore/);
    await expect(page.locator('a[href^="/trader/"]:visible').first()).toBeVisible();
    await page.locator('a[href^="/trader/"]:visible').first().click();
    await expect(page).toHaveURL(/\/trader\/0x/, { timeout: 20000 });
    await expect(page.getByRole("main")).toBeVisible();
  });
}
