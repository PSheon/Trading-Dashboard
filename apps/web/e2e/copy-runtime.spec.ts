import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

const visible = (page: Page, text: string | RegExp) => page.getByText(text, { exact: typeof text === "string" }).filter({ visible: true });
const action = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).filter({ visible: true });
const performance = (page: Page) => page.locator("section").filter({ has: page.getByRole("radiogroup", { name: "Performance view" }) }).filter({ visible: true });
// 最近活動 of the paper view (the phone and desktop layouts each draw one).
const activity = (page: Page) => page.getByRole("region", { name: "Recent activity" }).filter({ visible: true });

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

/** The fixture records real observations, not seeded historical returns.
 * A browser clock creates a second observation without waiting a minute. */
async function openObservedCopy(page: Page) {
  await page.goto("/en/portfolio");
  await signIn(page);
  await page.getByRole("button", { name: /^Machi is ugly dog/ }).filter({ visible: true }).first().click();
  await expect(performance(page).getByTestId("copy-coverage")).toBeVisible();
}

async function startIdleCopy(page: Page, width: number) {
  await page.goto("/en/portfolio?paper=empty");
  await signIn(page);
  await page.getByRole("link", { name: "Find traders" }).filter({ visible: true }).click();
  await page.locator('a[href*="/trader/0x"]').filter({ visible: true }).first().click();
  if (width < 768) {
    await action(page, "Copy").click();
    const sheet = page.getByRole("dialog", { name: "Copy", exact: true });
    for (const key of ["5", "00"]) await sheet.getByRole("button", { name: key, exact: true }).click();
  } else {
    await page.getByRole("textbox", { name: "Amount to copy (USDC)" }).filter({ visible: true }).fill("500");
  }
  await action(page, "Additional settings").click();
  const adopt = page.getByRole("switch", { name: "Copy current positions" }).filter({ visible: true });
  await expect(adopt).toBeChecked();
  await adopt.click();
  await expect(adopt).not.toBeChecked();
  await action(page, "Start copying $500").click();
  await page.getByRole("link", { name: "Copying · Manage" }).filter({ visible: true }).click();
  await expect(action(page, "Withdraw paper funds")).toBeEnabled();
  await expect(visible(page, "No open positions")).toBeVisible();
}

for (const width of [1440, 390]) {
  test.describe(`paper copy runtime at ${width}px`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: 900 }); });

    test("per-copy history contains observed points, preserves unknown daily P&L and labels stale snapshots", async ({ page }) => {
      test.setTimeout(90000);
      await openObservedCopy(page);
      // One observation so far: no line is drawn from it.
      await expect(performance(page)).toContainText("No chart data yet");
      await expect(performance(page)).toContainText("Partial history");
      await expect(performance(page).locator("strong")).toHaveText("—");
      await expect(performance(page)).toContainText("P&L excludes cash transfers");
      // Keep recovery reachable, but reserved collateral cannot fund a new withdrawal.
      await expect(action(page, "Withdraw paper funds")).toBeEnabled();
      await action(page, "Withdraw paper funds").click();
      const withdrawal = page.getByRole("dialog", { name: /^Withdraw paper funds/ });
      await expect(withdrawal).toContainText("Available: $0.00");
      await withdrawal.getByLabel(/^USDC/).fill("1");
      await expect(withdrawal.getByRole("button", { name: "Confirm withdrawal", exact: true })).toBeDisabled();
      await expect(withdrawal.getByRole("button", { name: /^Resolve withdrawal/ })).toHaveCount(0);
      await withdrawal.getByRole("button", { name: "Close", exact: true }).click();
      const now = await page.evaluate(() => Date.now());
      await page.clock.install({ time: now });
      await page.clock.setSystemTime(now + 60_000);
      await performance(page).getByRole("radio", { name: /^30D$/i }).click();
      await expect(performance(page).getByRole("img", { name: "Your copy's PnL history" })).toBeVisible();
      // Moving wall time leaves query timers untouched. Opening settings
      // rerenders the existing confirmed history without capturing a new point.
      await page.clock.setSystemTime(now + 5 * 60_000);
      await action(page, "Add funds").click();
      await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
      await expect(performance(page)).toContainText("Snapshot stale");
    });

    for (const withdrawalUsd of [400, 500]) test(`idle $${withdrawalUsd} withdrawal resolves the original operation with $${500 - withdrawalUsd} remaining`, async ({ page }) => {
      test.setTimeout(120000);
      const remaining = `$${(500 - withdrawalUsd).toFixed(2)}`;
      const withdrawn = `$${withdrawalUsd.toFixed(2)}`;
      await startIdleCopy(page, width);
      await action(page, "Withdraw paper funds").click();
      const dialog = page.getByRole("dialog", { name: /^Withdraw paper funds/ });
      await expect(dialog).toContainText("Available: $500.00");
      const amount = dialog.getByLabel(/^USDC/);
      const confirm = dialog.getByRole("button", { name: "Confirm withdrawal", exact: true });
      await amount.fill("501");
      await expect(confirm).toBeDisabled();
      await amount.fill(String(withdrawalUsd));
      await page.evaluate(() => sessionStorage.setItem("orbie:fixtures:copy-fail", "withdraw_response"));
      await confirm.click();
      await expect(dialog.getByRole("alert")).toContainText("Withdrawal failed");
      await expect(dialog).toContainText(`Available: ${remaining}`);
      const pending = await page.evaluate(() => {
        const key = Object.keys(sessionStorage).find((key) => key.startsWith("orbie:copy-operations:withdraw:"));
        return key ? JSON.parse(sessionStorage.getItem(key) ?? "[]") as [string, string][] : [];
      });
      expect(pending).toHaveLength(1);
      expect(pending[0][1]).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(pending[0][0])).toMatchObject({ amountUsd: withdrawalUsd });
      await expect(amount).toHaveValue(String(withdrawalUsd));
      await expect(confirm).toBeDisabled();
      // Closing the dialog must not discard the uncertain operation, even
      // when a full withdrawal leaves no collateral for another request.
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(action(page, "Withdraw paper funds")).toBeEnabled();
      await action(page, "Withdraw paper funds").click();
      await expect(dialog).toContainText(`Available: ${remaining}`);
      const resolve = dialog.getByRole("button", { name: `Resolve withdrawal ${withdrawn}`, exact: true });
      await expect(resolve).toBeEnabled();
      await expect(confirm).toBeDisabled();
      await resolve.click();
      await expect(dialog).toHaveCount(0);
      expect(await page.evaluate(() => {
        const key = Object.keys(sessionStorage).find((key) => key.startsWith("orbie:copy-operations:withdraw:"));
        return key ? JSON.parse(sessionStorage.getItem(key) ?? "[]") : [];
      })).toEqual([]);
      // A lost response committed the first withdrawal. Replaying its key
      // leaves the already-confirmed balance and clears the original intent.
      await action(page, "Withdraw paper funds").click();
      await expect(dialog).toContainText(`Available: ${remaining}`);
      await page.keyboard.press("Escape");
      // Cash transfers change equity, not earned P&L or gross allocation.
      const pnl = page.locator("p").filter({ hasText: /^Total P&L$/ }).filter({ visible: true }).locator("..").locator("p.num");
      await expect(pnl).toHaveText("$0.00");
      // Plain words, newest first; no copy number or order id (Paul, 2026-10-06). The feed polls every 15 s.
      const transferred = activity(page).locator("li").filter({ hasText: "Funds withdrawn" });
      await expect(transferred).toHaveCount(1, { timeout: 20000 });
      await expect(transferred).toContainText(withdrawn);
      await expect(activity(page)).toContainText("Copy created");
      await expect(activity(page)).not.toContainText("#");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  });
}
