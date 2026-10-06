import { expect, test, type Page } from "@playwright/test";
import { expectNoSidewaysScroll, shot, signIn } from "./helpers";

/**
 * One-click testnet copy (docs/one-click-copy-plan-2026-10-05.md) against
 * the fixture api with the fixture signer: 測試網 on the trader panel, the
 * confirm sheet with every term, the progress dialog through each stage,
 * and the portfolio row's pause / resume / edit. The fixture setup moves
 * one stage per read, as the worker would.
 */
// A trader the fixture account does not paper-copy (its phone bar says 跟單, not 管理).
const TRADER = "/en/trader/0x005a09b498f2a28b54652a70d7812e63414161fe?signer=fixture&wallet=funded";
const action = (page: Page, name: string | RegExp) => page.getByRole("button", { name, exact: typeof name === "string" }).filter({ visible: true });

for (const width of [1440, 390]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`one-click testnet copy at ${width}px (${scheme})`, async ({ page, context, baseURL }) => {
      test.setTimeout(120000);
      const errors: string[] = [];
      page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text()); });
      page.on("response", (response) => { if (response.status() >= 400 && !response.url().includes("/api/coin-icon/")) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
      await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      // A phone's trader page has no sign-in button: sign in first, then open it.
      await page.goto("/en/portfolio?signer=fixture&wallet=funded");
      await signIn(page);
      await page.goto(TRADER);
      let panel = page.locator("body");
      if (width < 768) {
        await action(page, "Copy").click();
        panel = page.getByRole("dialog", { name: "Copy", exact: true });
      }
      // 模擬 by default; 測試網 shows the main wallet's testnet balance.
      const mode = panel.getByRole("radiogroup", { name: "Copy mode" }).filter({ visible: true });
      await expect(mode.getByRole("radio", { name: "Paper" })).toHaveAttribute("aria-checked", "true");
      await mode.getByRole("radio", { name: "Testnet" }).click();
      await expect(panel.getByText("Main wallet (testnet)").filter({ visible: true }).first()).toBeVisible();
      await expect(panel.getByText(/1,180\.17/).filter({ visible: true }).first()).toBeVisible();
      await action(page, "Additional settings").click();
      const adopt = page.getByRole("switch", { name: "Copy current positions" }).filter({ visible: true });
      await expect(adopt).toBeDisabled();
      await expect(page.getByText("Testnet copies follow new trades only; current positions are not copied.").filter({ visible: true })).toBeVisible();
      if (width < 768) {
        for (const key of ["1", "5", "0"]) await panel.getByRole("button", { name: key, exact: true }).click();
        await action(page, "Start copying $150").click();
      } else {
        const amount = page.getByRole("textbox", { name: "Amount to copy (USDC)" }).filter({ visible: true });
        await amount.fill("150");
        // A real form: Enter starts it.
        await amount.press("Enter");
      }
      const confirm = page.getByRole("dialog", { name: "Confirm your copy" });
      await expect(confirm).toBeVisible();
      const terms = confirm.getByTestId("live-copy-terms");
      for (const text of ["150 USDC", "Follow", "Hyperliquid testnet (test funds)", "Trading agent valid until", "Positions close and the funds return to your main wallet automatically"]) await expect(terms).toContainText(text);
      await expectNoSidewaysScroll(page);
      await page.waitForTimeout(500); // the dialog has finished fading in
      await shot(page, `testnet-copy-confirm-${width}-${scheme}`);
      await confirm.getByRole("button", { name: "Confirm and start" }).click();
      const progress = page.getByRole("dialog", { name: /Setting up your copy|Copying has started/ });
      await expect(progress).toBeVisible();
      await expect(progress).toContainText("You can close this window; setup continues in the background.");
      await page.waitForTimeout(500); // the dialog has finished fading in
      await shot(page, `testnet-copy-progress-${width}-${scheme}`);
      await expect(page.getByRole("dialog", { name: "Copying has started" })).toBeVisible({ timeout: 30000 });
      await expect(progress.getByTestId("live-copy-stages").locator('[data-state="done"]')).toHaveCount(6);
      await page.getByRole("link", { name: "Go to portfolio" }).click();
      await expect(page).toHaveURL(/\/en\/portfolio/);
      const copies = page.getByRole("region", { name: "Testnet copies" }).filter({ visible: true });
      await expect(copies).toContainText("Active");
      await expect(copies).toContainText(/Runs until/);
      // Pause and resume need no signature.
      await copies.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(copies).toContainText("Paused");
      await copies.getByRole("button", { name: "Resume", exact: true }).click();
      await expect(copies).toContainText("Active");
      // Edit: one consent, a new generation.
      await copies.getByRole("button", { name: "Edit settings", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "Edit settings" });
      await edit.getByRole("textbox").first().fill("200");
      await edit.getByRole("button", { name: "Save", exact: true }).click();
      const confirmEdit = page.getByRole("dialog", { name: "Confirm the new settings" });
      await expect(confirmEdit.getByTestId("live-copy-terms")).toContainText("200 USDC");
      await confirmEdit.getByRole("button", { name: "Confirm and start" }).click();
      await expect(page.getByRole("dialog", { name: "Copying has started" })).toBeVisible({ timeout: 30000 });
      await page.getByRole("dialog", { name: "Copying has started" }).getByRole("button", { name: "Close", exact: true }).first().click();
      await expectNoSidewaysScroll(page);
      await page.waitForTimeout(500); // the dialog has finished fading in
      await shot(page, `testnet-copy-portfolio-${width}-${scheme}`);
      expect(errors.filter((text) => !/Download the React DevTools|favicon/.test(text))).toEqual([]);
    });
  }
}

/** Starts a 150 USDC testnet copy from the trader panel in zh-TW and confirms it. */
async function startOwnerCopy(page: Page, width: number, flags: string) {
  // A phone's trader page has no sign-in button: sign in first, then open it.
  await page.goto(`/zh-TW/portfolio?signer=fixture&wallet=funded&${flags}`);
  await page.getByRole("button", { name: /^(示範登入|登入)$/ }).filter({ visible: true }).first().click();
  await page.goto(`/zh-TW/trader/0x005a09b498f2a28b54652a70d7812e63414161fe?signer=fixture&wallet=funded&${flags}`);
  let panel = page.locator("body");
  if (width < 768) {
    await action(page, "跟單").click();
    panel = page.getByRole("dialog", { name: "跟單", exact: true });
  }
  await panel.getByRole("radiogroup", { name: "跟單模式" }).filter({ visible: true }).getByRole("radio", { name: "測試網" }).click();
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
  await confirm.getByRole("button", { name: "確認並開始" }).click();
}
const pageErrors = (page: Page) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 400 && !response.url().includes("/api/coin-icon/")) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  return () => errors.filter((text) => !/Download the React DevTools|favicon/.test(text));
};

// The owner's browser signs (no worker policy): at the account and agent
// steps the fixture parks the copy account's action, and the open dialog
// signs it with that copy account and sends it back: no extra click.
for (const width of [1440, 390]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`an owner-signed setup finishes with the dialog open at ${width}px (${scheme}, zh-TW)`, async ({ page, context, baseURL }) => {
      test.setTimeout(120000);
      const errors = pageErrors(page);
      await context.addCookies([{ name: "locale", value: "zh-TW", url: baseURL! }]);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await startOwnerCopy(page, width, "setup=owner");
      const progress = page.getByRole("dialog", { name: /正在設定跟單|跟單已開始/ });
      await expect(progress).toBeVisible();
      await expect(progress).toContainText("關閉後設定會暫停，之後在投資組合點「繼續設定」即可接續。");
      await page.waitForTimeout(500); // the dialog has finished fading in
      await shot(page, `testnet-copy-owner-progress-${width}-${scheme}`);
      // Account setup and the trading agent are each signed by the copy wallet in this browser.
      await expect(page.getByRole("dialog", { name: "跟單已開始" })).toBeVisible({ timeout: 30000 });
      await expect(progress.getByTestId("live-copy-stages").locator('[data-state="done"]')).toHaveCount(6);
      await expect(progress.getByRole("alert")).toHaveCount(0);
      await expectNoSidewaysScroll(page);
      await shot(page, `testnet-copy-owner-done-${width}-${scheme}`);
      expect(errors()).toEqual([]);
    });
  }
}

test("a copy wallet the browser can't use yet is named calmly; the dialog closed, 繼續設定 resumes and finishes", async ({ page, context, baseURL }) => {
  test.setTimeout(120000);
  const errors = pageErrors(page);
  await context.addCookies([{ name: "locale", value: "zh-TW", url: baseURL! }]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await startOwnerCopy(page, 1440, "setup=owner&copywallet=late");
  const progress = page.getByRole("dialog", { name: "正在設定跟單" });
  const alert = progress.getByRole("alert");
  await expect(alert).toHaveText("這個瀏覽器還讀不到你的跟單錢包，請重新整理頁面後繼續。", { timeout: 30000 });
  await page.waitForTimeout(500);
  await shot(page, "testnet-copy-owner-wallet-error-1440");
  // Closing pauses it (the tab could close here): the portfolio resumes it.
  await progress.getByRole("button", { name: "關閉", exact: true }).last().click();
  await expect(progress).toHaveCount(0);
  await page.locator('a[href="/zh-TW/portfolio"]').filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/zh-TW\/portfolio/);
  const resume = page.getByRole("button", { name: "繼續設定", exact: true }).filter({ visible: true }).first();
  await expect(resume).toBeVisible({ timeout: 15000 });
  await shot(page, "testnet-copy-owner-resume-1440");
  await resume.click();
  await expect(page.getByRole("dialog", { name: "跟單已開始" })).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole("dialog", { name: "跟單已開始" }).getByTestId("live-copy-stages").locator('[data-state="done"]')).toHaveCount(6);
  expect(errors()).toEqual([]);
});

test("the automatic return: confirm adds the worker from the browser and the worker finishes; declined, the browser signs instead", async ({ page, context, baseURL }) => {
  test.setTimeout(120000);
  const errors = pageErrors(page);
  await context.addCookies([{ name: "locale", value: "zh-TW", url: baseURL! }]);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Privy refuses adding the signer (or the owner declines): no error, the setup is signed in this browser.
  await startOwnerCopy(page, 1440, "signers=fail");
  const progress = page.getByRole("dialog", { name: /正在設定跟單|跟單已開始/ });
  await expect(progress).toContainText("關閉後設定會暫停，之後在投資組合點「繼續設定」即可接續。");
  await expect(page.getByRole("dialog", { name: "跟單已開始" })).toBeVisible({ timeout: 30000 });
  await expect(progress.getByRole("alert")).toHaveCount(0);
  await shot(page, "testnet-copy-signer-declined-1440");
  expect(errors()).toEqual([]);
});

test("the step-by-step forms moved to /dev/copy; Settings keeps the read-only copy wallets", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await page.goto("/en/settings?tab=account");
  await signIn(page);
  await expect(page.getByRole("region", { name: "Copy execution wallets" })).toHaveCount(0);
  await page.goto("/en/dev/copy");
  await expect(page.getByRole("region", { name: "Copy execution wallets" })).toBeVisible();
});
