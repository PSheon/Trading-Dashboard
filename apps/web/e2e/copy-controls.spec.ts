import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * Pause, resume and edit stay on the user pages on condition that they are
 * tested front to back (owner's decision; CopyDog has stop only). These
 * drive the real portfolio UI against the fixture account, whose state lives
 * in the page: every step after the first load is a client-side navigation.
 */
test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

const visible = (page: Page, text: string | RegExp) => page.getByText(text, { exact: typeof text === "string" }).filter({ visible: true });
const action = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).filter({ visible: true });
/** A row of the copy's settings card ("Mode" → "Ratio"). */
const setting = (page: Page, label: string) => page.locator("dl > div").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).filter({ visible: true }).locator("dd");
const failNext = (page: Page, kind: "patch" | "commands") => page.evaluate((k) => sessionStorage.setItem("orbie:fixtures:copy-fail", k), kind);

async function openCopy(page: Page, trader: string) {
  await page.goto("/en/portfolio");
  await signIn(page);
  await page.getByRole("button", { name: new RegExp(`^${trader}`) }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/[?&]copy=\d+/);
  await expect(action(page, "Edit settings")).toBeVisible();
}

for (const width of [1440, 390]) {
  test.describe(`copy controls at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test("local copy selection and Back work without Flight requests and preserve query and hash", async ({ page, baseURL }) => {
      await page.goto("/en/portfolio?view=copying&tag=alpha&tag=beta#paper");
      await signIn(page);
      const copy = page.getByRole("button", { name: /^Machi is ugly dog/ }).filter({ visible: true }).first();
      await expect(copy).toBeVisible();
      const flights: string[] = [];
      // The copy query is local state: selection must keep working with server navigation unavailable.
      await page.route(/\/portfolio\?.*_rsc=/, async (route) => {
        flights.push(route.request().url());
        await route.abort("blockedbyclient");
      });
      const historyLength = await page.evaluate(() => history.length);
      await copy.click();
      await expect(page).toHaveURL(`${baseURL}/en/portfolio?view=copying&tag=alpha&tag=beta&copy=1#paper`);
      await expect(action(page, "Edit settings")).toBeVisible();
      await action(page, "Back").click();
      await expect(page).toHaveURL(`${baseURL}/en/portfolio?view=copying&tag=alpha&tag=beta#paper`);
      await expect(copy).toBeVisible();
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      expect(flights).toEqual([]);
    });

    test("pause and resume show their state on the copy, the list and the trader page", async ({ page }) => {
      test.setTimeout(90000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await openCopy(page, "Machi is ugly dog");
      // Copying: no status chip, Pause offered, two positions.
      await expect(action(page, "Pause copying")).toBeVisible();
      await expect(action(page, "Resume copying")).toHaveCount(0);
      await expect(visible(page, "Paused")).toHaveCount(0);
      await expect(visible(page, "Settings v1")).toBeVisible();

      await action(page, "Pause copying").click();
      await expect(action(page, "Resume copying")).toBeVisible();
      await expect(action(page, "Pause copying")).toHaveCount(0);
      await expect(visible(page, "Paused")).toBeVisible();
      // A pause is not an edit and closes nothing.
      await expect(visible(page, "Settings v1")).toBeVisible();
      await expect(visible(page, "No open positions")).toHaveCount(0);

      // The list shows it too (both seeded copies are paused now).
      await action(page, "Back").click();
      await expect(page).not.toHaveURL(/copy=/);
      await expect(visible(page, "Paused")).toHaveCount(2);
      await page.getByRole("button", { name: /^Machi is ugly dog/ }).filter({ visible: true }).first().click();

      // …and so does the trader page's copy panel, which leads back here.
      await page.getByRole("link", { name: "Machi is ugly dog", exact: true }).filter({ visible: true }).click();
      await expect(page).toHaveURL(/\/trader\/0x89da/);
      // Phones: the panel is a sheet behind the bottom button.
      if (width < 768) await page.getByRole("button", { name: /^Copy/ }).filter({ visible: true }).last().click();
      const manage = page.getByRole("link", { name: "Copying · Manage" }).filter({ visible: true });
      await expect(manage).toBeVisible({ timeout: 20000 });
      await expect(visible(page, "Paused")).toBeVisible();
      await manage.click();
      await expect(page).toHaveURL(/\/portfolio\?copy=1/);

      await action(page, "Resume copying").click();
      await expect(action(page, "Pause copying")).toBeVisible();
      await expect(visible(page, "Paused")).toHaveCount(0);
      await action(page, "Back").click();
      await expect(visible(page, "Paused")).toHaveCount(1);
      expect(errors).toEqual([]);
    });

    test("an edit saves a new settings version and shows it; invalid amounts can't be saved", async ({ page }) => {
      test.setTimeout(90000);
      await openCopy(page, "Machi is ugly dog");
      await expect(setting(page, "Mode")).toHaveText("Ratio");
      await expect(setting(page, "Per Trade")).toHaveText("—");
      await expect(setting(page, "Max Allocation")).toHaveText("$10,000.00");

      await action(page, "Edit settings").click();
      const dialog = page.getByRole("dialog", { name: "Copy Trade Settings" });
      const save = dialog.getByRole("button", { name: "Save", exact: true });
      await expect(dialog.getByRole("radio", { name: "Ratio" })).toBeChecked();
      await expect(dialog.getByLabel(/Amount Per Trade/)).toHaveCount(0);
      await dialog.getByRole("radio", { name: "Fixed" }).click();
      // Fixed needs its amount, no larger than the cap, and a cap above zero.
      await expect(save).toBeDisabled();
      await dialog.getByLabel(/Max Allocation/).fill("4000");
      await dialog.getByLabel(/Amount Per Trade/).fill("5000");
      await expect(save).toBeDisabled();
      await dialog.getByLabel(/Amount Per Trade/).fill("250");
      await expect(save).toBeEnabled();
      await dialog.getByLabel(/Max Allocation/).fill("");
      await expect(save).toBeDisabled();
      await dialog.getByLabel(/Max Allocation/).fill("4000");
      await save.click();
      await expect(dialog).toHaveCount(0);

      await expect(visible(page, "Settings v2")).toBeVisible();
      await expect(setting(page, "Mode")).toHaveText("Fixed");
      await expect(setting(page, "Per Trade")).toHaveText("$250.00");
      await expect(setting(page, "Max Allocation")).toHaveText("$4,000.00");
      // Still copying, with its positions.
      await expect(action(page, "Pause copying")).toBeVisible();
      await expect(visible(page, "No open positions")).toHaveCount(0);

      // The dialog reopens on what was saved; back to ratio is version 3.
      await action(page, "Edit settings").click();
      await expect(dialog.getByRole("radio", { name: "Fixed" })).toBeChecked();
      await expect(dialog.getByLabel(/Amount Per Trade/)).toHaveValue("250");
      await expect(dialog.getByLabel(/Max Allocation/)).toHaveValue("4000");
      await dialog.getByRole("radio", { name: "Ratio" }).click();
      await save.click();
      await expect(dialog).toHaveCount(0);
      await expect(visible(page, "Settings v3")).toBeVisible();
      await expect(setting(page, "Mode")).toHaveText("Ratio");
      await expect(setting(page, "Per Trade")).toHaveText("—");
      await expect(setting(page, "Max Allocation")).toHaveText("$4,000.00");

      // A paused copy can be edited and stays paused.
      await action(page, "Pause copying").click();
      await action(page, "Edit settings").click();
      await dialog.getByLabel(/Max Allocation/).fill("6000");
      await save.click();
      await expect(visible(page, "Settings v4")).toBeVisible();
      await expect(action(page, "Resume copying")).toBeVisible();
    });

    test("a failed pause, resume or save says so, changes nothing, and works on the next try", async ({ page }) => {
      test.setTimeout(90000);
      await openCopy(page, "Machi is ugly dog");
      const failed = page.getByRole("alert").filter({ hasText: "Failed to update configuration" });

      await failNext(page, "commands");
      await action(page, "Pause copying").click();
      await expect(failed).toBeVisible();
      await expect(action(page, "Pause copying")).toBeEnabled();
      await expect(visible(page, "Paused")).toHaveCount(0);
      await action(page, "Pause copying").click();
      await expect(action(page, "Resume copying")).toBeVisible();
      await expect(failed).toHaveCount(0);

      await failNext(page, "commands");
      await action(page, "Resume copying").click();
      await expect(failed).toBeVisible();
      await expect(visible(page, "Paused")).toBeVisible();
      await action(page, "Resume copying").click();
      await expect(action(page, "Pause copying")).toBeVisible();
      await expect(failed).toHaveCount(0);

      // The dialog stays open with what was typed.
      await action(page, "Edit settings").click();
      const dialog = page.getByRole("dialog", { name: "Copy Trade Settings" });
      await dialog.getByLabel(/Max Allocation/).fill("3000");
      await failNext(page, "patch");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog.getByRole("alert")).toHaveText("Failed to update configuration");
      await expect(dialog.getByLabel(/Max Allocation/)).toHaveValue("3000");
      await expect(visible(page, "Settings v1")).toBeVisible();
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(visible(page, "Settings v2")).toBeVisible();
      await expect(setting(page, "Max Allocation")).toHaveText("$3,000.00");
    });

    test("start a copy on the trader page, pause it, resume it, then stop it", async ({ page }) => {
      test.setTimeout(120000);
      await page.goto("/en/portfolio?paper=empty");
      await signIn(page);
      // Client-side from here on: the fixture account lives in this page.
      await page.getByRole("link", { name: "Find traders" }).filter({ visible: true }).click();
      await page.locator('a[href*="/trader/0x"]').filter({ visible: true }).first().click();
      await expect(page).toHaveURL(/\/trader\/0x/, { timeout: 30000 });
      if (width < 768) {
        // Phones: the sheet has its own keypad (the field is read-only).
        await action(page, "Copy").click();
        const sheet = page.getByRole("dialog", { name: "Copy" });
        for (const key of ["5", "00"]) await sheet.getByRole("button", { name: key, exact: true }).click();
      } else {
        await page.getByRole("textbox", { name: "Amount to copy (USDC)" }).filter({ visible: true }).fill("500");
      }
      await action(page, "Start copying $500").click();
      // 跟單目前持倉: the answer says which of the trader's positions were not copied.
      await expect(page.getByText("Copied 1 of 2 open positions. Not copied: TSLA")).toBeVisible({ timeout: 20000 });
      const manage = page.getByRole("link", { name: "Copying · Manage" }).filter({ visible: true });
      await expect(manage).toBeVisible({ timeout: 20000 });
      await manage.click();
      await expect(page).toHaveURL(/\/portfolio\?copy=\d+/);
      await expect(visible(page, "$500.00").first()).toBeVisible();
      await expect(visible(page, "Settings v1")).toBeVisible();

      await action(page, "Pause copying").click();
      await expect(visible(page, "Paused")).toBeVisible();
      await action(page, "Resume copying").click();
      await expect(visible(page, "Paused")).toHaveCount(0);

      await action(page, "Stop copying").click();
      const stop = page.getByRole("dialog", { name: "Stop Copying" });
      await expect(stop).toContainText("They will be automatically closed.");
      await stop.getByRole("button", { name: "Stop & Close", exact: true }).click();
      await expect(stop).toHaveCount(0);
      // Stopped: the chip, no positions, and no controls left.
      await expect(visible(page, "Stopped")).toBeVisible();
      await expect(visible(page, "No open positions")).toBeVisible();
      for (const name of ["Pause copying", "Resume copying", "Edit settings", "Stop copying"]) await expect(action(page, name)).toHaveCount(0);
    });
  });
}
