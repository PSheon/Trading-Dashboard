import { expect, test, type Page } from "@playwright/test";
import { expectNoSidewaysScroll, selectTradingMode, shot } from "./helpers";

/**
 * One-click testnet copy off the happy path (logic review 2026-10-06 §A),
 * against the fixture api with the fixture signer, in zh-TW at 1440 and
 * 390, light and dark:
 *
 * - 開始跟單, the confirm sheet closed, the page reloaded: 繼續設定 brings
 *   the same sheet back and the copy starts.
 * - A start that fails after its deposit arrived (`?setup=fail`): the
 *   dialog says so and offers 重新開始 / 取消設定; 重新開始 copies the same
 *   trader again, and the old copy account offers 全部返還主錢包.
 * - 取消設定 ends it; account deletion is then held only by the funds left
 *   in that copy account, no longer by the copy itself.
 */
const LEADER = "0x005a09b498f2a28b54652a70d7812e63414161fe";
const action = (page: Page, name: string | RegExp) => page.getByRole("button", { name, exact: typeof name === "string" }).filter({ visible: true });

function pageErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text()); });
  page.on("response", (response) => {
    // DELETE /me answering its blocker is the point of the last test.
    if (response.status() >= 400 && !response.url().includes("/api/coin-icon/") && !(response.status() === 409 && response.request().method() === "DELETE")) errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  return () => errors.filter((text) => !/Download the React DevTools|favicon/.test(text));
}

/** The trader's copy panel (the phone's 跟單 sheet). */
async function panelOf(page: Page, width: number) {
  if (width >= 768) return page.locator("body");
  await page.getByTestId("trader-copy-bar").getByRole("button").click();
  return page.getByRole("dialog", { name: "跟單", exact: true });
}
/** Signs in and opens the trader in zh-TW with these fixture flags, in 測試網. */
async function openTrader(page: Page, width: number, flags = "") {
  await page.goto(`/zh-TW/portfolio?signer=fixture&wallet=funded${flags ? `&${flags}` : ""}`);
  await page.getByRole("button", { name: /^(示範登入|登入)$/ }).filter({ visible: true }).first().click();
  await page.goto(`/zh-TW/trader/${LEADER}?signer=fixture&wallet=funded${flags ? `&${flags}` : ""}`);
  await selectTradingMode(page, "testnet", "zh-TW");
  const panel = await panelOf(page, width);
  return panel;
}
/** 開始跟單 $150 from the panel: the confirm sheet. */
async function startCopy(page: Page, panel: ReturnType<Page["locator"]>, width: number) {
  if (width < 768) {
    for (const key of ["1", "5", "0"]) await panel.getByRole("button", { name: key, exact: true }).click();
    await action(page, "開始跟單 $150").click();
  } else {
    const amount = page.getByRole("textbox", { name: "跟單金額（USDC）" }).filter({ visible: true });
    await amount.fill("150");
    await amount.press("Enter");
  }
  const confirm = page.getByRole("dialog", { name: "確認跟單設定" });
  await expect(confirm.getByTestId("live-copy-terms")).toContainText("150 USDC");
  return confirm;
}
const settle = (page: Page) => page.waitForTimeout(500); // a dialog has finished fading in

for (const width of [1440, 390]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${width}px ${scheme}`, () => {
      test.beforeEach(async ({ page, context, baseURL }) => {
        await context.addCookies([{ name: "locale", value: "zh-TW", url: baseURL! }]);
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
      });

      test("the confirm sheet closed and the page reloaded: 繼續設定 brings it back and the copy starts", async ({ page }) => {
        test.setTimeout(120000);
        const errors = pageErrors(page);
        const confirm = await startCopy(page, await openTrader(page, width), width);
        await confirm.getByRole("button", { name: "取消", exact: true }).click();
        await expect(confirm).toHaveCount(0);
        await page.reload();
        await selectTradingMode(page, "testnet", "zh-TW");
        const panel = await panelOf(page, width);
        await expect(panel.getByText("等待你確認").filter({ visible: true })).toBeVisible({ timeout: 15000 });
        await expectNoSidewaysScroll(page);
        await shot(page, `testnet-recovery-reloaded-${width}-${scheme}`);
        await action(page, "繼續設定").click();
        const again = page.getByRole("dialog", { name: "確認跟單設定" });
        await expect(again.getByTestId("live-copy-terms")).toContainText("150 USDC");
        await settle(page);
        await shot(page, `testnet-recovery-sheet-again-${width}-${scheme}`);
        await again.getByRole("button", { name: "確認並開始" }).click();
        await expect(page.getByRole("dialog", { name: "跟單已開始" })).toBeVisible({ timeout: 30000 });
        expect(errors()).toEqual([]);
      });

      test("a start that failed after its deposit: 重新開始 copies the same trader again; the old account offers the return", async ({ page }) => {
        test.setTimeout(120000);
        const errors = pageErrors(page);
        const confirm = await startCopy(page, await openTrader(page, width, "setup=fail"), width);
        await confirm.getByRole("button", { name: "確認並開始" }).click();
        const failed = page.getByRole("dialog", { name: "設定未完成" });
        await expect(failed).toBeVisible({ timeout: 30000 });
        await expect(failed.getByRole("alert")).toContainText("跟單帳戶設定失敗");
        await expect(failed).toContainText("已入帳的 USDC 留在跟單錢包");
        await expect(failed.getByRole("button", { name: "取消設定" })).toBeVisible();
        await settle(page);
        await expectNoSidewaysScroll(page);
        await shot(page, `testnet-recovery-failed-${width}-${scheme}`);
        await failed.getByRole("button", { name: "重新開始" }).click();
        const again = page.getByRole("dialog", { name: "確認跟單設定" });
        await expect(again.getByTestId("live-copy-terms")).toContainText("150 USDC");
        await again.getByRole("button", { name: "確認並開始" }).click();
        await expect(page.getByRole("dialog", { name: "跟單已開始" })).toBeVisible({ timeout: 30000 });
        await page.getByRole("link", { name: "前往投資組合" }).click();
        await expect(page).toHaveURL(/\/zh-TW\/portfolio/);
        // The new strategy is enabled, but absent observations must not imply confirmed execution or P&L.
        // The previous account is preparing its return, not already credited.
        const cards = page.getByTestId("live-copy-card").filter({ visible: true });
        await expect(cards.filter({ hasText: "策略已啟用" })).toBeVisible();
        await expect(cards.filter({ hasText: "策略已啟用" })).toContainText("帳戶觀察尚未確認");
        await cards.filter({ hasText: "準備返還" }).click();
        const copies = page.getByTestId("live-copy-sheet");
        await expect(copies).toContainText("資金返還中");
        await expect(copies.getByRole("button", { name: "全部返還主錢包" })).toBeVisible();
        await expectNoSidewaysScroll(page);
        await shot(page, `testnet-recovery-restarted-portfolio-${width}-${scheme}`);
        expect(errors()).toEqual([]);
      });

      test("取消設定 ends a failed start; account deletion is then held only by the funds left in its copy account", async ({ page }) => {
        test.setTimeout(120000);
        const errors = pageErrors(page);
        const panel = await openTrader(page, width, "setup=fail");
        const confirm = await startCopy(page, panel, width);
        await confirm.getByRole("button", { name: "確認並開始" }).click();
        const failed = page.getByRole("dialog", { name: "設定未完成" });
        await expect(failed).toBeVisible({ timeout: 30000 });
        await failed.getByRole("button", { name: "取消設定" }).click();
        const cancelled = page.getByRole("dialog", { name: "已取消" });
        await expect(cancelled).toBeVisible();
        await cancelled.getByRole("button", { name: "關閉", exact: true }).last().click();
        // The panel is a new start again (no 跟單中, no 重新開始).
        if (width < 768) await page.keyboard.press("Escape");
        await page.reload();
        const after = await panelOf(page, width);
        await expect(after.getByText("最低 $100 才能跟單").or(after.getByText("請輸入金額")).filter({ visible: true }).first()).toBeVisible({ timeout: 15000 });
        await expect(after.getByRole("link", { name: "管理", exact: true }).filter({ visible: true })).toHaveCount(0);
        await shot(page, `testnet-recovery-cancelled-panel-${width}-${scheme}`);
        await page.goto(`/zh-TW/settings?${width < 768 ? "view=account" : "tab=account"}`);
        await page.getByRole("button", { name: "刪除帳號", exact: true }).filter({ visible: true }).first().click();
        const dialog = page.getByRole("dialog", { name: "刪除帳號" });
        await dialog.getByRole("checkbox").check();
        await dialog.getByPlaceholder("DELETE").fill("DELETE");
        await dialog.getByRole("button", { name: "永久刪除帳號" }).click();
        const blocked = dialog.getByRole("alert").filter({ hasText: "還不能刪除帳號" });
        await expect(blocked).toContainText("跟單帳戶裡還有資金、持倉或掛單。先在投資組合把資金轉回主錢包。");
        await expect(blocked).not.toContainText("你還有進行中的測試網跟單");
        await expectNoSidewaysScroll(page);
        await shot(page, `testnet-recovery-delete-${width}-${scheme}`);
        expect(errors()).toEqual([]);
      });
    });
  }
}
