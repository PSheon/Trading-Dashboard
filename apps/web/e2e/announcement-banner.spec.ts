import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, shot } from "./helpers";

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

/** F7 option B: one 36px line — pill, phrase (md up), Learn more ›, ✕. */
test("the announcement is one line on desktop and drops its phrase on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/en/explore");
  const banner = page.getByTestId("announcement-banner");
  await expect(banner).toBeVisible();
  expect((await banner.boundingBox())!.height).toBe(36);
  await expect(banner).toContainText("Public beta");
  await expect(page.getByTestId("announcement-summary")).toBeVisible();
  await expect(banner.getByRole("link", { name: "Learn more", exact: true })).toHaveAttribute("href", "/en/help");
  await shot(page, "announcement-1440");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("announcement-summary")).toBeHidden();
  await expect(banner.getByRole("link", { name: "Learn more", exact: true })).toBeVisible();
  await expect(banner.getByRole("button", { name: "Close announcement" })).toBeVisible();
  expect((await banner.boundingBox())!.height).toBe(36);
  await expectNoSidewaysScroll(page);
  await shot(page, "announcement-390");
});

test("closing the announcement keeps it closed after a reload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/en/explore");
  await page.getByTestId("announcement-banner").getByRole("button", { name: "Close announcement" }).click();
  await expect(page.getByTestId("announcement-banner")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expect(page.getByTestId("announcement-banner")).toHaveCount(0);
});
