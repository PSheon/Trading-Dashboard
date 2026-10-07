import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, shot } from "./helpers";

/** Review finding 52: the insights headline is the tier's only once most of
 * its members were read. The fixtures serve 極度盈利 fully read and, for the
 * lab's tier picker, a tier read to 33 of 150. */
for (const width of [1440, 390]) {
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
    await expectNoSidewaysScroll(page);
    await shot(page, `insights-ready-${width}`);

    // The lab's tier picker reaches the other tiers: this one has 33 of 150 members read.
    await page.goto("/zh-TW/dev/wealth/insights?tier=rekt");
    // Said in the status line and in the per-market map (no empty box there).
    await expect(page.getByText("此分層的持倉資料建立中，第一次刷新約需數分鐘。")).toHaveCount(2, { timeout: 20000 });
    await expect(page.getByText("此分層的持倉資料建立中，第一次刷新約需數分鐘。").first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "名目金額", exact: true })).toHaveCount(0);
    await expect(page.getByText("7% 做多")).toHaveCount(0);
    // What was read is still listed.
    await expect(page.getByRole("table").first()).toBeVisible();
    await shot(page, `insights-building-${width}`);
  });
}
