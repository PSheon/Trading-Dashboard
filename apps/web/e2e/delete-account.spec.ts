import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, shot } from "./helpers";

/**
 * The delete-account dialog when something is still in flight
 * (docs/account-deletion.md): it names the blocker, says what to do and links
 * to it, and the account stays signed in. `?deleteBlock=` makes the fixture
 * api answer that 409.
 */
const cases = [
  { code: "copies_active", text: "你還有進行中的測試網跟單。先在投資組合停止跟單，並把資金轉回主錢包。", link: "前往這個跟單", href: /\/zh-TW\/portfolio\?copy=1$/ },
  { code: "withdrawal_pending", text: "主錢包有一筆提領還在確認中。等它完成後再刪除。", button: "查看提領" },
] as const;

for (const width of [1440, 390]) for (const theme of ["light", "dark"] as const) for (const c of cases) {
  test(`delete account explains ${c.code} at ${width}px (${theme})`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "locale", value: "zh-TW", url: baseURL! }, { name: "theme", value: theme, url: baseURL! }]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/zh-TW/settings?${width < 768 ? "view=account&" : "tab=account&"}deleteBlock=${c.code}`);
    // The fixture account's demo login, in Chinese (helpers.signIn is English).
    await page.getByRole("button", { name: /^(示範登入|登入)$/ }).filter({ visible: true }).first().click();
    await page.getByRole("button", { name: "刪除帳號", exact: true }).filter({ visible: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "刪除帳號" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("會保留的紀錄");
    await dialog.getByRole("checkbox").check();
    await dialog.getByPlaceholder("DELETE").fill("DELETE");
    await dialog.getByRole("button", { name: "永久刪除帳號" }).click();
    const blocked = dialog.getByRole("alert").filter({ hasText: "還不能刪除帳號" });
    await expect(blocked).toContainText(c.text);
    if ("link" in c) await expect(blocked.getByRole("link", { name: c.link })).toHaveAttribute("href", c.href);
    else await expect(blocked.getByRole("button", { name: c.button })).toBeVisible();
    // Still signed in, still on settings: nothing was deleted.
    await expect(page).toHaveURL(/\/zh-TW\/settings/);
    await expectNoSidewaysScroll(page);
    await shot(page, `delete-account-${c.code}-${width}-${theme}`);
  });
}
