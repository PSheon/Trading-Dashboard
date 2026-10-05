import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, shot } from "./helpers";

/** Owner's decisions of 2026-10-02. The fixture server has no api behind its
 * server components (NEXT_API_URL is empty), so the coin page decides in the
 * browser here; the HTTP status of an unknown market is covered by
 * test/coin-presence.test.ts and the api's discovery spec. */

for (const width of [1440, 390]) {
  test(`a real Hyperliquid market nobody has traded is a page with CopyDog's empty state, not a 404, at ${width}px`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "locale", value: "zh-TW", url: baseURL! }]);
    await page.setViewportSize({ width, height: 900 });
    for (const [slug, label] of [["MEGA", "MEGA"], ["xyz-AAPL", "AAPL"]]) {
      const response = await page.goto(`/zh-TW/coins/${slug}`);
      expect(response?.status(), slug).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: `Hyperliquid 上最強的 ${label} 交易員` })).toBeVisible();
      await expect(page.getByTestId("coin-no-data")).toHaveText("尚無市場資料。");
      await expect(page.getByRole("table")).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1, name: "404" })).toHaveCount(0);
      await expectNoSidewaysScroll(page);
    }
    await shot(page, `coin-no-data-${width}`);

    // A market with traders still has its table.
    await page.goto("/zh-TW/coins/BTC");
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByTestId("coin-no-data")).toHaveCount(0);

    // A name that is no Hyperliquid market stays the 404.
    await page.goto("/zh-TW/coins/NOPE123");
    await expect(page.getByRole("heading", { level: 1, name: "404" })).toBeVisible();
    await expect(page.getByTestId("coin-no-data")).toHaveCount(0);
  });

  test(`繁中 says 你 and 交易員 on the signed-out pages at ${width}px, and settings does not mention 帳單`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "locale", value: "zh-TW", url: baseURL! }]);
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/zh-TW", "/zh-TW/explore", "/zh-TW/portfolio", "/zh-TW/favorites", "/zh-TW/settings", "/zh-TW/insights", "/zh-TW/coins"]) {
      await page.goto(path);
      await expect(page.locator("main, [role=dialog]").filter({ visible: true }).first()).toBeVisible();
      const text = await page.locator("body").innerText();
      expect(text, path).not.toMatch(/您/);
      expect(text, path).not.toMatch(/交易者/);
      expect(text, path).not.toMatch(/帳單/);
    }
    await page.goto("/zh-TW/portfolio");
    await expect(page.getByText("登入以查看你的投資組合").filter({ visible: true }).first()).toBeVisible();
    await shot(page, `wording-portfolio-${width}`);
  });
}
