import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, expectNoSidewaysScroll, shot, signIn, chooseOption } from "./helpers";

/**
 * The copy-trading admin against the fixture account (an admin). Its state
 * lives in the page, so after the first load every step is a client-side
 * navigation through the admin's own links.
 */
test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

const section = (page: Page, name: string) => page.getByRole("navigation", { name: "Copy trading" }).getByRole("link", { name, exact: true });
/** A row of the user-exposure table. */
const userRow = (page: Page, name: string) => page.getByRole("region", { name: "User exposure" }).getByRole("row").filter({ hasText: name });
/** Radix fades the dialog in; a scan mid-fade reads blended colours. */
const settled = (page: Page) => page.getByRole("dialog").evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
const armStale = (page: Page, kind: "control" | "risk") => page.evaluate((k) => sessionStorage.setItem("orbie:fixtures:admin-copy-stale", k), kind);

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/admin/copy");
  await signIn(page);
  await expect(page.getByRole("region", { name: "Platform stop state" })).toBeVisible({ timeout: 20000 });
}

/** Fills the confirmation and sends it. */
async function confirm(page: Page, command: string, word: string, reason: string) {
  const dialog = page.getByRole("dialog", { name: command });
  const send = dialog.getByRole("button", { name: `Confirm: ${command}`, exact: true });
  await expect(send).toBeDisabled();
  await dialog.getByLabel(/^Reason/).fill(reason);
  await expect(send).toBeDisabled();
  await dialog.getByLabel(`Type ${word} to confirm`).fill(word.toLowerCase());
  await expect(send).toBeEnabled();
  await send.click();
  return dialog;
}

for (const width of [1440, 390]) {
  test.describe(`copy admin at ${width}px`, () => {
    test("status: the platform's state and commands, stuck orders with their ledger; a platform pause needs a reason and the typed word", async ({ page }) => {
      test.setTimeout(90000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, width);
      const platform = page.getByRole("region", { name: "Platform stop state" });
      await expect(platform.getByText("Paper", { exact: true })).toBeVisible();
      await expect(platform.getByText("Running", { exact: true })).toBeVisible();
      await expect(platform.getByText(/revision 4 · risk policy v2 · signal backlog 2/)).toBeVisible();
      // An order the executor cannot book is on the page, with its error and how often it failed.
      const stuck = page.getByTestId("copy-stuck-orders");
      await expect(stuck.getByRole("heading", { name: /Orders that keep failing/ })).toBeVisible();
      await expect(stuck).toContainText("Order #9041 · ETH · reduce · reduce-only");
      await expect(stuck).toContainText("numeric field overflow");
      await expect(stuck).toContainText("Failed attempts: 7");
      await expectNoSidewaysScroll(page);
      await expectAccessible(page);
      await shot(page, `admin-copy-status-${width}`);
      // Its strategy's ledger opens in a drawer (the old copy/strategies/[id] page).
      await stuck.getByRole("button", { name: "Strategy #4" }).click();
      await expect(page).toHaveURL(/\/admin\/copy\?strategy=4$/);
      const ledger = page.getByRole("dialog", { name: "Strategy #4" });
      await expect(ledger.getByRole("heading", { name: "Ledger", exact: true })).toBeVisible({ timeout: 20000 });
      await ledger.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/copy$/);

      await platform.getByRole("button", { name: "Pause new risk", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Pause new risk" });
      await expect(dialog).toContainText("All users (platform)");
      await settled(page);
      await expectAccessible(page);
      await shot(page, `admin-copy-dialog-${width}`);
      await confirm(page, "Pause new risk", "PAUSE", "Drill: stale mids from Hyperliquid");
      await expect(dialog).toHaveCount(0);
      await expect(platform.getByText("New risk paused", { exact: true })).toBeVisible();
      await expect(platform.getByText(/revision 5/)).toBeVisible();
      await expect(platform.getByRole("button", { name: "Pause new risk", exact: true })).toBeDisabled();
      await expect(page.getByRole("region", { name: "Recent stop and resume commands" }).getByText("Drill: stale mids from Hyperliquid", { exact: true }).filter({ visible: true })).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("a command that lost to another one says so, shows the newer revision and can be sent again", async ({ page }) => {
      test.setTimeout(90000);
      await open(page, width);
      const platform = page.getByRole("region", { name: "Platform stop state" });
      await armStale(page, "control");
      await platform.getByRole("button", { name: "Close all positions", exact: true }).click();
      const dialog = await confirm(page, "Close all positions", "CLOSE ALL", "Kill switch test");
      await expect(dialog.getByRole("alert")).toContainText("Another command changed this stop state");
      // The page behind reloaded: the other operator's reduce-only, revision 5.
      await expect(dialog.getByText("5", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Confirm: Close all positions", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(platform.getByText("New risk paused", { exact: true })).toBeVisible();
      await expect(platform.getByText("Reduce-only", { exact: true }).first()).toBeVisible();
      await expect(platform.getByText(/revision 6/)).toBeVisible();
      // Every open position of the four live copies got its close.
      const commands = page.getByRole("region", { name: "Recent stop and resume commands" });
      await expect(commands.getByText("Kill switch test", { exact: true }).filter({ visible: true })).toBeVisible();
      if (width >= 640) await expect(commands.getByText("0 cancelled · 6 closes", { exact: true })).toBeVisible();

      await platform.getByRole("button", { name: "Resume", exact: true }).click();
      await confirm(page, "Resume", "RESUME", "Test over");
      await expect(platform.getByText("Running", { exact: true })).toBeVisible();
    });

    test("user exposure: a row's Stop… changes that user's stop state, not the platform's; Expand shows the user's copies with their ledger", async ({ page }) => {
      test.setTimeout(90000);
      await open(page, width);
      const sam = userRow(page, "degen_sam@example.com");
      const anonymous = userRow(page, "#12");
      await expect(sam.getByText("Running", { exact: true })).toBeVisible();
      await expect(anonymous.getByText("Reduce-only", { exact: true }).first()).toBeVisible();
      await expectNoSidewaysScroll(page);

      await sam.getByRole("button", { name: "Stop commands for degen_sam@example.com" }).click();
      await page.getByRole("menuitem", { name: "Pause new risk", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Pause new risk" })).toContainText("degen_sam@example.com");
      await confirm(page, "Pause new risk", "PAUSE", "Exposure review");
      await expect(sam.getByText("New risk paused", { exact: true })).toBeVisible();

      await anonymous.getByRole("button", { name: "Stop commands for #12" }).click();
      await page.getByRole("menuitem", { name: "Resume", exact: true }).click();
      await confirm(page, "Resume", "RESUME", "Review done");
      await expect(anonymous.getByText("Running", { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "Platform stop state" }).getByText("Running", { exact: true })).toBeVisible();

      // Expand: the user's copies inline, each with its ledger.
      const demo = userRow(page, "demo@example.com");
      await demo.getByRole("button", { name: "Expand", exact: true }).click();
      await expect(demo.getByRole("button", { name: "Collapse", exact: true })).toHaveAttribute("aria-expanded", "true");
      const copies = page.locator("[id^=copy-user-]");
      await expect(copies.getByRole("button", { name: "Ledger" }).first()).toBeVisible();
      await expectAccessible(page);
      await shot(page, `admin-copy-users-${width}`);
      await copies.getByRole("button", { name: "Ledger" }).first().click();
      const ledger = page.getByRole("dialog", { name: /^Strategy #\d+$/ });
      await expect(ledger.getByText(/^Settings v\d+$/)).toBeVisible({ timeout: 20000 });
      await settled(page);
      await expectAccessible(page);
      await shot(page, `admin-copy-ledger-${width}`);
    });

    test("orders: the list with reasons, filtered to the failed ones", async ({ page }) => {
      test.setTimeout(90000);
      await open(page, width);
      await section(page, "Orders").click();
      await expect(page).toHaveURL(/\/admin\/copy\/orders$/);
      await expect(page.getByText("13 orders", { exact: true })).toBeVisible({ timeout: 20000 });
      await chooseOption(page, page.getByRole("combobox", { name: "Order status" }), "failed");
      await expect(page).toHaveURL(/status=failed/);
      await expect(page.getByText("5 orders", { exact: true })).toBeVisible();
      await expect(page.getByText("User is reduce-only", { exact: true }).filter({ visible: true }).first()).toBeVisible();
      await expect(page.getByText("Signal was too old", { exact: true }).filter({ visible: true }).first()).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectAccessible(page);
      await shot(page, `admin-copy-orders-${width}`);
    });

    test("testnet copies: latency P50/P95, wallets with their grant, orders with an unknown outcome; revoking a grant needs a reason", async ({ page }) => {
      test.setTimeout(90000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page, width);
      await section(page, "Testnet").click();
      await expect(page).toHaveURL(/\/admin\/copy\/testnet$/);
      const latency = page.getByTestId("copy-live-latency");
      await expect(latency).toContainText("9 copied fills");
      await expect(latency).toContainText("840 ms");
      await expect(latency).toContainText("58,900 ms");
      await latency.getByRole("button", { name: "7 d", exact: true }).click();
      await expect(latency).toContainText("61 copied fills");
      const wallets = page.getByRole("region", { name: "Execution wallets" });
      await expect(wallets).toContainText("demo@example.com");
      await expect(wallets).toContainText("mainnet leader");
      const orders = page.getByRole("region", { name: "Orders" });
      await expect(orders).toContainText("exchange_order_not_yet_found");
      await orders.getByRole("button", { name: "Unknown outcome", exact: true }).click();
      await expect(page.getByText(/the exchange has not confirmed yet/)).toBeVisible();
      await expect(page.getByRole("region", { name: "Wallet transfers" })).toContainText("50 USDC");
      await expectNoSidewaysScroll(page);
      await expectAccessible(page);
      await shot(page, `admin-copy-live-${width}`);

      await wallets.getByRole("button", { name: "Revoke grant", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Revoke trading grant" });
      await settled(page);
      await expectAccessible(page);
      const send = dialog.getByRole("button", { name: "Revoke", exact: true });
      await expect(send).toBeDisabled();
      await dialog.getByLabel("Reason").fill("Drill: agent key rotation");
      await send.click();
      await expect(dialog).toBeHidden();
      // A running copy is stopped first; the grant is revoked when the stop ends.
      await expect(wallets).toContainText("revoke requested");
      await expect(wallets).toContainText("requested");
      // Revoking now, without the stop, needs an explicit confirmation.
      await wallets.getByRole("button", { name: "Revoke now", exact: true }).click();
      const force = page.getByRole("dialog", { name: "Revoke now, without waiting for the stop" });
      await settled(page);
      await expectAccessible(page);
      await force.getByLabel("Reason").fill("Drill: stop is stuck");
      const now = force.getByRole("button", { name: "Revoke now", exact: true });
      await expect(now).toBeDisabled();
      await force.getByLabel("I understand that positions may remain open on the copy account with nobody to close them.").check();
      await now.click();
      await expect(force).toBeHidden();
      await expect(wallets).toContainText("revoked");
      await expect(wallets.getByRole("button", { name: /^Revoke (grant|now)$/ })).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test("risk limits: an impossible policy can't be saved; a save needs a reason and becomes the next version", async ({ page }) => {
      test.setTimeout(90000);
      await open(page, width);
      await section(page, "Risk").click();
      await expect(page.getByRole("heading", { name: "Platform risk limits", exact: true })).toBeVisible({ timeout: 20000 });
      // The four common limits first; the rest under 進階.
      await expect(page.getByLabel("Max leverage (×)")).toBeHidden();
      await page.getByRole("button", { name: "Advanced" }).click();
      await expect(page.getByText("Current v2", { exact: true })).toBeVisible();
      const save = page.getByRole("button", { name: "Save as v3", exact: true });
      await expect(save).toBeDisabled();
      await expectNoSidewaysScroll(page);
      await expectAccessible(page);
      await shot(page, `admin-copy-risk-${width}`);

      const leverage = page.getByLabel("Max leverage (×)");
      await expect(leverage).toHaveValue("8");
      await leverage.fill("5");
      await expect(save).toBeDisabled();
      await page.getByLabel("Reason for this change (required)").fill("Tighter before testnet");
      await expect(save).toBeEnabled();
      // Minimum above maximum: refused in the form, as the api refuses it.
      await page.getByLabel("Minimum allocation (USDC)").fill("200000");
      await expect(page.getByText("Must not exceed maxAllocationUsd")).toBeVisible();
      await expect(save).toBeDisabled();
      await page.getByLabel("Minimum allocation (USDC)").fill("100");
      await leverage.fill("");
      await expect(save).toBeDisabled();
      await leverage.fill("5");

      // Someone else saved v3 first: nothing of ours is saved until we reload.
      await armStale(page, "risk");
      await save.click();
      await expect(page.getByRole("alert").filter({ hasText: "Someone else saved a newer policy" })).toBeVisible();
      await page.getByRole("button", { name: "Reload", exact: true }).click();
      await expect(page.getByText("Current v3", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Advanced" }).click();
      await expect(page.getByLabel("Max leverage (×)")).toHaveValue("8");

      await page.getByLabel("Max leverage (×)").fill("5");
      await page.getByLabel("Reason for this change (required)").fill("Tighter before testnet");
      await page.getByRole("button", { name: "Save as v4", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("Saved as v4");
      await expect(page.getByText("Current v4", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Advanced" }).click();
      await expect(page.getByLabel("Max leverage (×)")).toHaveValue("5");
      const history = page.getByRole("table");
      await expect(history.getByText("v4 · current", { exact: true })).toBeVisible();
      await expect(history.getByText("Tighter before testnet", { exact: true })).toBeVisible();
    });
  });
}

test("the old copy admin URLs land on the copy tab", async ({ page }) => {
  for (const [from, to] of [["/admin/copy/users", /\/admin\/copy$/], ["/admin/copy/strategies", /\/admin\/copy$/], ["/admin/copy/strategies/2", /\/admin\/copy\?strategy=2$/], ["/admin/copy/live", /\/admin\/copy\/testnet$/]] as const) {
    await page.goto(from);
    await expect(page).toHaveURL(to);
  }
});
