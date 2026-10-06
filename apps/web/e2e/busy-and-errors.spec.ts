import { expect, test, type Page } from "@playwright/test";
import { expectNoSidewaysScroll, shot } from "./helpers";

/**
 * Stream 21 (Paul, 2026-10-06), against the fixture api, in zh-TW at 1440
 * and 390, light and dark:
 *
 * - every async button shows Orbie's orbit mark while its action runs: the
 *   copy panel's CTA, the confirm sheet, a wallet action in Settings (提款)
 *   and an admin action (site settings 儲存). The fixture api is slowed
 *   (`orbie:fixtures:delay`) so the busy state can be seen and captured;
 * - the progress dialog says a passing failure calmly (Hyperliquid busy:
 *   `?setup=busy`), keeps its stages and finishes; and it says where the
 *   money is when a deposit was never seen credited (`?setup=uncredited`).
 */
const LEADER = "0x005a09b498f2a28b54652a70d7812e63414161fe";
const action = (page: Page, name: string | RegExp) => page.getByRole("button", { name, exact: typeof name === "string" }).filter({ visible: true });
const slow = (page: Page, ms: number | null) => page.evaluate((delay) => { if (delay === null) sessionStorage.removeItem("orbie:fixtures:delay"); else sessionStorage.setItem("orbie:fixtures:delay", String(delay)); }, ms);
/** The pressable now busy (its label may change while it is: 準備中…, 儲存中…). */
const busyButton = (page: Page) => page.locator('button[aria-busy="true"], [role="menuitem"][aria-busy="true"]').filter({ visible: true }).first();
const login = (page: Page) => page.getByRole("button", { name: /^(示範登入|登入)$/ }).filter({ visible: true }).first().click();

function pageErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 400 && !response.url().includes("/api/coin-icon/")) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  return () => errors.filter((text) => !/Download the React DevTools|favicon/.test(text));
}

/** Opens the trader's testnet copy panel (the phone's 跟單 sheet) and types 150. */
async function testnetPanel(page: Page, width: number, flags: string) {
  await page.goto(`/zh-TW/portfolio?signer=fixture&wallet=funded&${flags}`);
  await login(page);
  await page.goto(`/zh-TW/trader/${LEADER}?signer=fixture&wallet=funded&${flags}`);
  let panel = page.locator("body");
  if (width < 768) {
    await action(page, "跟單").click();
    panel = page.getByRole("dialog", { name: "跟單", exact: true });
  }
  await panel.getByRole("radiogroup", { name: "跟單模式" }).filter({ visible: true }).getByRole("radio", { name: "測試網" }).click();
  if (width < 768) for (const key of ["1", "5", "0"]) await panel.getByRole("button", { name: key, exact: true }).click();
  else await page.getByRole("textbox", { name: "跟單金額（USDC）" }).filter({ visible: true }).fill("150");
}

for (const width of [1440, 390]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${width}px ${scheme}`, () => {
      test.beforeEach(async ({ page, context, baseURL }) => {
        await context.addCookies([{ name: "locale", value: "zh-TW", url: baseURL! }]);
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
      });

      test("the copy panel and the confirm sheet show they are busy; the progress dialog says busy calmly and finishes", async ({ page }) => {
        test.setTimeout(120000);
        const errors = pageErrors(page);
        await testnetPanel(page, width, "setup=busy");
        await slow(page, 2500);
        await action(page, "開始跟單 $150").click();
        await expect(busyButton(page).locator("[data-orbit-spinner]")).toBeVisible();
        await shot(page, `busy-panel-${width}-${scheme}`);
        const confirm = page.getByRole("dialog", { name: "確認跟單設定" });
        await expect(confirm.getByTestId("live-copy-terms")).toContainText("150 USDC", { timeout: 15000 });
        const confirmButton = confirm.getByRole("button", { name: "確認並開始" });
        await page.waitForTimeout(400); // the sheet has finished fading in
        await confirmButton.click();
        await expect(confirm.locator('button[aria-busy="true"] [data-orbit-spinner]')).toBeVisible();
        await shot(page, `busy-confirm-${width}-${scheme}`);
        await slow(page, null);
        // Hyperliquid busy on the first reads: a calm line, no alert, the stages kept.
        const progress = page.getByRole("dialog", { name: /正在設定跟單|跟單已開始/ });
        const retrying = progress.getByTestId("live-copy-retrying");
        await expect(retrying).toHaveText("忙碌中，自動重試…", { timeout: 15000 });
        await expect(progress.getByRole("alert")).toHaveCount(0);
        await expect(progress.getByTestId("live-copy-stages").locator("li")).toHaveCount(6);
        await expectNoSidewaysScroll(page);
        await shot(page, `progress-busy-${width}-${scheme}`);
        await expect(page.getByRole("dialog", { name: "跟單已開始" })).toBeVisible({ timeout: 30000 });
        await expect(progress.getByRole("alert")).toHaveCount(0);
        expect(errors()).toEqual([]);
      });

      test("a deposit never seen credited: the dialog says where the money went, and offers 取消設定", async ({ page }) => {
        test.setTimeout(120000);
        const errors = pageErrors(page);
        await testnetPanel(page, width, "setup=uncredited");
        await action(page, "開始跟單 $150").click();
        const confirm = page.getByRole("dialog", { name: "確認跟單設定" });
        await expect(confirm.getByTestId("live-copy-terms")).toContainText("150 USDC", { timeout: 15000 });
        await confirm.getByRole("button", { name: "確認並開始" }).click();
        const ended = page.getByRole("dialog", { name: "設定已逾時" });
        await expect(ended.getByRole("alert")).toHaveText(/^150 USDC 已送往跟單錢包 0x2c2c…2c2c，但 Hyperliquid 一直沒有確認入帳。/, { timeout: 30000 });
        await expect(ended.getByRole("button", { name: "取消設定" })).toBeVisible();
        await page.waitForTimeout(400);
        await expectNoSidewaysScroll(page);
        await shot(page, `progress-error-${width}-${scheme}`);
        expect(errors()).toEqual([]);
      });

      test("a wallet action in Settings (提款) shows it is busy", async ({ page }) => {
        test.setTimeout(60000);
        await page.goto("/zh-TW/settings?tab=funds&wallet=funded&signer=fixture");
        await login(page);
        // A phone's Settings is a menu: 交易紀錄 opens the funds view.
        if (width < 768) await action(page, "交易紀錄").first().click();
        await action(page, "提款").first().click();
        const dialog = page.getByRole("dialog");
        const [destination, amount] = [dialog.locator("input").nth(0), dialog.locator("input").nth(1)];
        await destination.fill(`0x${"22".repeat(20)}`);
        await amount.fill("12.5");
        await slow(page, 2500);
        const submit = dialog.locator('form button[type="submit"]');
        await submit.click();
        await expect(submit).toHaveAttribute("aria-busy", "true");
        await expect(submit.locator("[data-orbit-spinner]")).toBeVisible();
        await shot(page, `busy-settings-withdraw-${width}-${scheme}`);
        await slow(page, null);
      });

      test("an admin action (site settings 儲存) shows it is busy", async ({ page }) => {
        test.setTimeout(60000);
        await page.goto("/zh-TW/admin/settings");
        await login(page);
        const favorites = page.locator("#general").getByLabel("每位使用者可收藏的交易員數");
        await expect(favorites).toBeVisible({ timeout: 20000 });
        await favorites.fill("50");
        await slow(page, 2500);
        const save = page.getByRole("region", { name: "儲存後的變更" }).getByRole("button", { name: "儲存", exact: true }).filter({ visible: true }).first();
        await save.click();
        await expect(busyButton(page).locator("[data-orbit-spinner]")).toBeVisible();
        await shot(page, `busy-admin-settings-${width}-${scheme}`);
        await slow(page, null);
      });
    });
  }
}

/** Logic review 2026-10-06 (3.8): a second person signing in in the same tab
 * never sees the first one's confirm sheet, terms or setup. */
test("an account switch in the same tab shows the new person none of the previous one's setup or terms", async ({ page, context, baseURL }) => {
  test.setTimeout(120000);
  await context.addCookies([{ name: "locale", value: "zh-TW", url: baseURL! }]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await testnetPanel(page, 1440, "setup=owner");
  await action(page, "開始跟單 $150").click();
  const confirm = page.getByRole("dialog", { name: "確認跟單設定" });
  await expect(confirm.getByTestId("live-copy-terms")).toContainText("150 USDC", { timeout: 15000 });
  // The sheet is closed unconfirmed; the panel keeps it for this person.
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(page.getByText("等待你確認").filter({ visible: true }).first()).toBeVisible({ timeout: 15000 });
  // Sign out and in as someone else, in the same tab (no reload: the
  // page's in-memory stores survive, so this is what they must not leak).
  await page.getByRole("button", { name: "帳戶", exact: true }).filter({ visible: true }).first().click();
  await page.getByRole("menuitem", { name: "登出" }).click();
  await page.evaluate(() => history.replaceState(null, "", `${location.pathname}${location.search}&as=second`));
  await login(page);
  await expect(page.getByRole("radiogroup", { name: "跟單模式" }).filter({ visible: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole("radiogroup", { name: "跟單模式" }).filter({ visible: true }).getByRole("radio", { name: "測試網" }).click();
  await page.waitForTimeout(1500); // the portfolio poll has answered for the new person
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("live-copy-terms")).toHaveCount(0);
  await expect(page.getByText("等待你確認")).toHaveCount(0);
  // The new person's panel is the plain start form.
  await expect(action(page, "請輸入金額")).toBeVisible();
  await shot(page, "account-switch-second-person-1440");
});
