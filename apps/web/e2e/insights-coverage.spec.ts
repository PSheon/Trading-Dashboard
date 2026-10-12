import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, shot } from "./helpers";

/** Review finding 52: the insights headline is the tier's only once most of
 * its members were read. The fixtures serve 極度盈利 fully read and, for the
 * lab's tier picker, a tier read to 33 of 150. */
for (const width of [1440, 390]) {
  test(`insights identifies a usable partial summary at ${width}px`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "locale", value: "zh-TW", url: baseURL! }]);
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await page.goto("/zh-TW/dev/wealth/insights?tier=very_profitable");
    // The coverage is one pill by the title (UI text density review, F3).
    await expect(page.getByTestId("cohort-coverage")).toContainText("120/150", { timeout: 20000 });
    await expect(page.getByTestId("cohort-coverage")).toHaveAttribute("aria-label", "120 / 150 個錢包有最新快照");
    await expect(page.getByRole("heading", { level: 2, name: "名目金額", exact: true })).toBeVisible();
    const notional = await page.getByRole("heading", { level: 2, name: "名目金額", exact: true }).locator("..").innerText();
    const long = Number(notional.match(/(\d+)% 做多/)?.[1]);
    const short = Number(notional.match(/(\d+)% 做空/)?.[1]);
    expect(long + short).toBe(100);
    await expect(page.getByText("此分層的持倉資料尚未完整，背景持續更新中。")).toHaveCount(0);
    await expectNoSidewaysScroll(page);
    await shot(page, `insights-partial-${width}`);
  });

  test(`insights shows the headline of a fully read tier, and withholds it for a tier still being read, at ${width}px`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "locale", value: "zh-TW", url: baseURL! }]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/zh-TW/insights");
    const notional = page.getByRole("heading", { level: 2, name: "名目金額", exact: true });
    await expect(notional).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/72% 做多|73% 做多/).first()).toBeVisible();
    await expect(page.getByText("此分層的持倉資料建立中")).toHaveCount(0);
    // As on CopyDog: no coverage label.
    await expect(page.getByText(/個錢包有最新快照/)).toHaveCount(0);
    const pnlLegend = page.getByRole("heading", { level: 2, name: "未實現盈虧", exact: true }).locator("..").locator(".cd-bar + div > span");
    await expect(pnlLegend.nth(0)).toContainText("60% 獲利中");
    await expect(pnlLegend.nth(1)).toContainText("40% 虧損中");
    await expectNoSidewaysScroll(page);
    await shot(page, `insights-ready-${width}`);

    // The lab's tier picker reaches the other tiers: this one has 33 of 150 members read.
    await page.goto("/zh-TW/dev/wealth/insights?tier=rekt");
    // Said once, in the per-market map (no empty box there); the title's pill holds the rest.
    await expect(page.getByText("此分層的持倉資料尚未完整，背景持續更新中。")).toHaveCount(1, { timeout: 20000 });
    await expect(page.getByText("此分層的持倉資料尚未完整，背景持續更新中。").first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "名目金額", exact: true })).toHaveCount(0);
    await expect(page.getByText("7% 做多")).toHaveCount(0);
    await expect(page.getByText("歷史資料會在資料足夠後逐步累積。", { exact: true })).toBeVisible();
    await expect(page.getByText(/每 15 分鐘/)).toHaveCount(0);
    // What was read is still listed.
    if (width < 768) {
      const wallets = page.getByRole("main").getByRole("list").first();
      await expect(wallets).toBeVisible();
      await expect(wallets.getByRole("listitem").first()).toBeVisible();
    } else await expect(page.getByRole("table").first()).toBeVisible();
    await shot(page, `insights-building-${width}`);
  });
}
