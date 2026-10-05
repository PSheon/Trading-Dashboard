import { expect, test, type Page } from "@playwright/test";
import { chooseOption, expectAccessible, expectNoSidewaysScroll, shot, signIn } from "./helpers";

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

const row = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });
const settled = (page: Page) => page.getByRole("dialog").evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));

for (const width of [1440, 390]) {
  test(`a role change and a disable are confirmed before anything is sent at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/users");
    await signIn(page);
    const target = row(page, "whalewatcher");
    const role = target.getByRole("combobox", { name: "Role of whalewatcher" });
    await expect(role).toHaveText("User", { timeout: 20000 });
    // The seeded operator, and the signed-in admin who can't change themself.
    await expect(row(page, "Kaito").getByRole("combobox")).toHaveText("Operator (read-only)");
    await expect(row(page, "Demo").getByRole("combobox")).toBeDisabled();
    await expectNoSidewaysScroll(page);
    await expectAccessible(page);
    await shot(page, `admin-users-${width}`);

    // Choosing a role changes nothing by itself.
    await chooseOption(page, role, "operator");
    const dialog = page.getByRole("dialog", { name: "Change role?" });
    await expect(dialog).toContainText("Change whalewatcher from “User” to “Operator (read-only)”");
    await expect(dialog).toContainText("Cannot change settings, users, lists or rules");
    await settled(page);
    await expectAccessible(page);
    await shot(page, `admin-users-role-dialog-${width}`);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(role).toHaveText("User");

    await chooseOption(page, role, "operator");
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(role).toHaveText("Operator (read-only)");
    await chooseOption(page, role, "admin");
    await expect(dialog).toContainText("Admin: every permission");
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(role).toHaveText("Admin");

    await target.getByRole("button", { name: "Disable", exact: true }).click();
    const disable = page.getByRole("dialog", { name: "Disable this account?" });
    await expect(disable).toContainText("whalewatcher is signed out at once");
    await disable.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(target.getByRole("button", { name: "Disable", exact: true })).toBeVisible();
    await target.getByRole("button", { name: "Disable", exact: true }).click();
    await disable.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(target.getByRole("button", { name: "Enable", exact: true })).toBeVisible();
    await expect(target.getByText("Disabled", { exact: true })).toBeVisible();
  });

  test(`a read-only operator sees the admin pages with every write control off at ${width}px`, async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/users?as=operator");
    await signIn(page);
    const target = row(page, "whalewatcher");
    await expect(target.getByRole("combobox")).toBeDisabled({ timeout: 20000 });
    await expect(target.getByRole("button", { name: "Disable", exact: true })).toBeDisabled();
    const nav = page.getByRole("navigation", { name: "Admin" });
    await expect(nav.getByRole("link", { name: "Copy trading", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "KOLs", exact: true })).toHaveCount(0);
    await shot(page, `admin-users-operator-${width}`);

    // Client-side from here: the fixture identity lives in this page.
    await nav.getByRole("link", { name: "Copy trading", exact: true }).click();
    const platform = page.getByRole("region", { name: "Platform stop state" });
    await expect(platform.getByText("Running", { exact: true })).toBeVisible({ timeout: 20000 });
    for (const name of ["Pause new risk", "Reduce-only", "Cancel unsent orders", "Close all positions", "Resume"]) {
      await expect(platform.getByRole("button", { name, exact: true })).toBeDisabled();
    }
    await page.getByRole("navigation", { name: "Copy trading" }).getByRole("link", { name: "Risk limits", exact: true }).click();
    await expect(page.getByText("You can read the limits but not change them (risk.manage).")).toBeVisible({ timeout: 20000 });
    await expect(page.getByLabel("Max leverage (×)")).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Save as v/ })).toHaveCount(0);
    await shot(page, `admin-copy-risk-operator-${width}`);

    await nav.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.locator("#general").getByRole("button", { name: "Save section", exact: true })).toBeDisabled({ timeout: 20000 });
    await expect(page.locator("#general").getByRole("switch", { name: "Turn maintenance mode on" })).toBeDisabled();
  });
}

for (const width of [1440, 390]) {
  test(`a withdrawal in doubt is listed above the users and resolved with a reason at ${width}px`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/users?withdrawals=doubt");
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
