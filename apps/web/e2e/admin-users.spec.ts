import { expect, test, type Page } from "@playwright/test";
import { chooseOption, expectAccessible, expectNoSidewaysScroll, shot, signIn } from "./helpers";

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

const row = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });
const settled = (page: Page) => page.getByRole("dialog").last().evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));

for (const width of [1440, 390]) {
  test(`a role change and a disable are confirmed before anything is sent at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/en/admin/users");
    await signIn(page);
    const target = row(page, "whalewatcher");
    await expect(target.getByText("User", { exact: true })).toBeVisible({ timeout: 20000 });
    // The seeded operator.
    await expect(row(page, "Kaito").getByText("Operator (read + stop)", { exact: true })).toBeVisible();
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, `admin-users-${width}`);

    // Manage → a role (one of the two packs) → confirmed; nothing is sent before.
    const manage = async () => {
      await target.getByRole("button", { name: "Manage whalewatcher" }).click();
      const dialog = page.getByRole("dialog", { name: "whalewatcher" });
      await expect(dialog.getByRole("combobox", { name: "Role of whalewatcher" })).toBeVisible();
      return dialog;
    };
    let dialog = await manage();
    await settled(page);
    await expectAccessible(page);
    await chooseOption(page, dialog.getByRole("combobox", { name: "Role of whalewatcher" }), "operator");
    const confirmRole = page.getByRole("dialog", { name: "Change role?" });
    await expect(confirmRole).toContainText("Change whalewatcher from “User” to “Operator (read + stop)”");
    await expect(confirmRole).toContainText("can send the copy stop commands");
    await settled(page);
    await expectAccessible(page);
    await shot(page, `admin-users-role-dialog-${width}`);
    await confirmRole.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirmRole).toHaveCount(0);
    await expect(target.getByText("User", { exact: true })).toBeVisible();

    dialog = await manage();
    await chooseOption(page, dialog.getByRole("combobox", { name: "Role of whalewatcher" }), "operator");
    await confirmRole.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(target.getByText("Operator (read + stop)", { exact: true })).toBeVisible();
    dialog = await manage();
    await chooseOption(page, dialog.getByRole("combobox", { name: "Role of whalewatcher" }), "admin");
    await expect(confirmRole).toContainText("Admin: every permission");
    await confirmRole.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(target.getByText("Admin", { exact: true })).toBeVisible();

    dialog = await manage();
    await dialog.getByRole("button", { name: "Disable", exact: true }).click();
    const disable = page.getByRole("dialog", { name: "Disable this account?" });
    await expect(disable).toContainText("whalewatcher is signed out at once");
    await disable.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(target.getByText("Active", { exact: true })).toBeVisible();
    dialog = await manage();
    await dialog.getByRole("button", { name: "Disable", exact: true }).click();
    await disable.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(target.getByText("Disabled", { exact: true })).toBeVisible();
    // An admin can't change their own role or access.
    await row(page, "Demo").getByRole("button", { name: /^Manage / }).click();
    const self = page.getByRole("dialog");
    await expect(self.getByRole("combobox")).toBeDisabled();
    await expect(self.getByRole("button", { name: "Disable", exact: true })).toBeDisabled();
  });

  test(`an operator reads every tab, may send stop commands, and every other write control is off at ${width}px`, async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/en/admin/users?as=operator");
    await signIn(page);
    const target = row(page, "whalewatcher");
    await target.getByRole("button", { name: "Manage whalewatcher" }).click({ timeout: 20000 });
    const dialog = page.getByRole("dialog", { name: "whalewatcher" });
    await expect(dialog.getByRole("combobox")).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Disable", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    const nav = page.getByRole("navigation", { name: "Admin" });
    for (const name of ["Overview", "Copy trading", "Users", "Trader data", "Settings"]) await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
    await shot(page, `admin-users-operator-${width}`);

    // Client-side from here: the fixture identity lives in this page.
    await nav.getByRole("link", { name: "Copy trading", exact: true }).click();
    const platform = page.getByRole("region", { name: "Platform stop state" });
    await expect(platform.getByText("Running", { exact: true })).toBeVisible({ timeout: 20000 });
    for (const name of ["Pause new risk", "Reduce-only", "Cancel unsent orders", "Close all positions"]) {
      await expect(platform.getByRole("button", { name, exact: true })).toBeEnabled();
    }
    await expect(platform.getByRole("button", { name: "Resume", exact: true })).toBeDisabled();
    // A stop goes through for an operator.
    await platform.getByRole("button", { name: "Pause new risk", exact: true }).click();
    const stop = page.getByRole("dialog", { name: "Pause new risk" });
    await stop.getByLabel(/^Reason/).fill("Operator drill");
    await stop.getByLabel("Type PAUSE to confirm").fill("pause");
    await stop.getByRole("button", { name: "Confirm: Pause new risk", exact: true }).click();
    await expect(platform.getByText("New risk paused", { exact: true })).toBeVisible();
    await expect(platform.getByRole("button", { name: "Resume", exact: true })).toBeDisabled();
    await expectAccessible(page);
    await shot(page, `admin-copy-operator-${width}`);

    await page.getByRole("navigation", { name: "Copy trading" }).getByRole("link", { name: "Risk", exact: true }).click();
    await expect(page.getByText("You can read the limits but not change them (risk.manage).")).toBeVisible({ timeout: 20000 });
    await expect(page.getByLabel("Maximum order (USDC)")).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Save as v/ })).toHaveCount(0);
    await shot(page, `admin-copy-risk-operator-${width}`);

    // The KOL registry is not the operator's: the tab opens on the lists.
    await nav.getByRole("link", { name: "Trader data", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/traders\/lists$/, { timeout: 20000 });
    await expect(page.getByRole("link", { name: "KOL", exact: true })).toHaveCount(0);

    await nav.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByText("Read-only: only an admin can save settings.")).toBeVisible({ timeout: 20000 });
    await expect(page.locator("#general").getByRole("switch", { name: "Turn maintenance mode on" })).toBeDisabled();
    await expect(page.getByRole("region", { name: "Changes on save" }).getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  });
}

for (const width of [1440, 390]) {
  test(`a withdrawal in doubt is listed above the users and resolved with a reason at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/en/admin/users?withdrawals=doubt");
    await signIn(page);
    const panel = page.getByRole("region", { name: "Withdrawals in doubt" });
    await expect(panel).toContainText("alice@example.com", { timeout: 20000 });
    await expect(panel).toContainText("$12.50");
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, `admin-withdrawals-in-doubt-${width}`);
    await panel.getByRole("button", { name: "Resolve", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Resolve" });
    const confirm = dialog.getByRole("button", { name: "Read the ledger and resolve" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Reason (kept in the audit log)").fill("exchange answer lost");
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(panel).toContainText("Not in Hyperliquid's ledger: marked not executed.");
    await expect(panel).not.toContainText("alice@example.com");
  });
}
