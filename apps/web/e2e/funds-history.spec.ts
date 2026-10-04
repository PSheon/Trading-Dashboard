import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, shot, signIn } from "./helpers";

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

test("one money-flow history in settings: copy transfers and fees, filtered, at 1440px", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings?tab=funds");
  await signIn(page);
  const list = page.getByTestId("funds-history").filter({ visible: true });
  await expect(list).toContainText("Added to copy #1");
  await expect(list).toContainText("Paper account → copy #1");
  await expect(list).toContainText(/Copy #1 trading fees \(orders: \d+\)/);
  await page.getByRole("radio", { name: "Fees & funding" }).filter({ visible: true }).click();
  await expect(list).not.toContainText("Added to copy #1");
  await expect(list).toContainText("trading fees");
  await page.getByRole("radio", { name: "All" }).filter({ visible: true }).click();
  await shot(page, "funds-history-1440");
  await expectNoSidewaysScroll(page);
});

test("the same history on a phone's settings, at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings?view=history");
  await signIn(page).catch(() => undefined);
  await page.goto("/settings?view=history");
  const list = page.getByTestId("funds-history").filter({ visible: true });
  await expect(list).toContainText("Added to copy #2");
  await shot(page, "funds-history-390");
  await expectNoSidewaysScroll(page);
});
