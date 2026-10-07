import { expect, test, type Page } from "@playwright/test";
import { expectNoSidewaysScroll, selectTradingMode, shot, signIn } from "./helpers";

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
      await page.getByRole("button", { name: "Account", exact: true }).filter({ visible: true }).click();
      await expect(page.getByRole("menuitemradio", { name: "Paper", exact: true })).toHaveAttribute("aria-checked", "true");
      await page.getByRole("menuitemradio", { name: "Testnet", exact: true }).click();
      await selectTradingMode(page, "testnet", "zh-TW");
  let panel = page.locator("body");
      if (width < 768) {
        await action(page, "Copy").click();
        panel = page.getByRole("dialog", { name: "Copy", exact: true });
      }
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
      // A copy is a card (name, status; PnL and ROI) that opens its detail sheet.
      const card = page.getByTestId("live-copy-card").filter({ visible: true }).first();
      await expect(card).toContainText("Copying");
      await card.click();
      const copies = page.getByTestId("live-copy-sheet");
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
async function startCopy(page: Page, width: number, flags: string) {
  // A phone's trader page has no sign-in button: sign in first, then open it.
  await page.goto(`/zh-TW/portfolio?signer=fixture&wallet=funded&${flags}`);
  await page.getByRole("button", { name: /^(示範登入|登入)$/ }).filter({ visible: true }).first().click();
  await page.goto(`/zh-TW/trader/0x005a09b498f2a28b54652a70d7812e63414161fe?signer=fixture&wallet=funded&${flags}`);
  await selectTradingMode(page, "testnet", "zh-TW");
  let panel = page.locator("body");
  if (width < 768) {
    await action(page, "跟單").click();
    panel = page.getByRole("dialog", { name: "跟單", exact: true });
  }
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
  return confirm;
}
const pageErrors = (page: Page) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 400 && !response.url().includes("/api/coin-icon/")) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  return () => errors.filter((text) => !/Download the React DevTools|favicon/.test(text));
};
/** What the fixture wallet was asked to sign or add, in order. */
const walletCalls = (page: Page) => page.evaluate(() => (window as unknown as { __orbieFixtureSignerCalls?: string[] }).__orbieFixtureSignerCalls ?? []);

// The one signing model (2026-10-07): the browser signs the setup consent
// and the deposit and adds the worker (addSigners); the worker signs every
// other step under the owner's policy, so the copy reaches running with no
// other wallet request.
for (const width of [1440, 390]) {
  for (const scheme of ["light", "dark"] as const) {
    test(`a one-click start reaches running with only the consent, the deposit and addSigners in the browser at ${width}px (${scheme}, zh-TW)`, async ({ page, context, baseURL }) => {
      test.setTimeout(120000);
      const errors = pageErrors(page);
      await context.addCookies([{ name: "locale", value: "zh-TW", url: baseURL! }]);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await startCopy(page, width, "signers=ok");
      const progress = page.getByRole("dialog", { name: /正在設定跟單|跟單已開始/ });
      await expect(progress).toBeVisible();
      await expect(progress).toContainText("可以關閉此視窗，設定會在背景繼續。");
      await page.waitForTimeout(500); // the dialog has finished fading in
      await shot(page, `testnet-copy-worker-progress-${width}-${scheme}`);
      await expect(page.getByRole("dialog", { name: "跟單已開始" })).toBeVisible({ timeout: 30000 });
      await expect(progress.getByTestId("live-copy-stages").locator('[data-state="done"]')).toHaveCount(6);
      await expect(progress.getByRole("alert")).toHaveCount(0);
      expect(await walletCalls(page)).toEqual(["CopyLiveSetupConsent", "HyperliquidTransaction:UsdSend", "addSigners"]);
      await expectNoSidewaysScroll(page);
      await shot(page, `testnet-copy-worker-done-${width}-${scheme}`);
      expect(errors()).toEqual([]);
    });
  }
}

test("addSigners declined: nothing is deposited and the copy does not start; confirming again and allowing it starts the copy", async ({ page, context, baseURL }) => {
  test.setTimeout(120000);
  const errors = pageErrors(page);
  await context.addCookies([{ name: "locale", value: "zh-TW", url: baseURL! }]);
  await page.setViewportSize({ width: 1440, height: 900 });
  const confirm = await startCopy(page, 1440, "signers=decline-once");
  // The sheet stays, with what happened; no /confirm was sent (no progress dialog).
  await expect(confirm.getByRole("alert")).toHaveText("Orbie 需要加入它的簽署者才能執行這個跟單。沒有入金，跟單也沒有開始。請再試一次並允許。");
  await expect(page.getByRole("dialog", { name: /正在設定跟單|跟單已開始/ })).toHaveCount(0);
  expect(await walletCalls(page)).toEqual(["CopyLiveSetupConsent", "HyperliquidTransaction:UsdSend", "addSigners"]);
  await page.waitForTimeout(500);
  await shot(page, "testnet-copy-signer-declined-1440");
  // Allowed on the retry (the consent still valid): the copy starts.
  await confirm.getByRole("button", { name: "確認並開始" }).click();
  await expect(page.getByRole("dialog", { name: "跟單已開始" })).toBeVisible({ timeout: 30000 });
  expect(await walletCalls(page)).toEqual(["CopyLiveSetupConsent", "HyperliquidTransaction:UsdSend", "addSigners", "CopyLiveSetupConsent", "HyperliquidTransaction:UsdSend", "addSigners"]);
  expect(errors().filter((text) => !/409 \/me\/copy\/live\/setups/.test(text))).toEqual([]);
});

test("the step-by-step forms moved to /dev/copy; Settings keeps the read-only copy wallets", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await page.goto("/en/settings?tab=account");
  await signIn(page);
  await expect(page.getByRole("region", { name: "Copy execution wallets" })).toHaveCount(0);
  await page.goto("/en/dev/copy");
  await expect(page.getByRole("region", { name: "Copy execution wallets" })).toBeVisible();
});
