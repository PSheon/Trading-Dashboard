import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, signIn } from "./helpers";

for (const width of [1440, 390]) test(`execution wallet settings explain unavailable preparation at ${width}px`, async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(width < 768 ? "/settings?view=account" : "/settings?tab=account");
  await signIn(page);
  const section = page.getByRole("region", { name: "Copy execution wallets" }).filter({ visible: true });
  await expect(section).toBeVisible();
  await expect(section).toContainText("Wallet preparation is currently unavailable.");
  await expect(section).toContainText("Prepare an empty wallet owned by you for a copy. This does not fund it or enable live trading.");
  await expect(section).toContainText("Testnet");
  await expect(section).toContainText("No signing authorizations.");
  await expect(section.getByRole("button", { name: "Prepare dedicated wallet", exact: true })).toBeDisabled();
  const funding = section.getByRole("region", { name: "Testnet strategy funding" });
  await expect(funding).toBeVisible();
  await expect(funding).toContainText("Mainnet strategy funding is not available yet, or the wallet provider is unavailable.");
  await expect(funding).toContainText("Receiving funds does not start copying or increase your paper balance.");
  await expect(funding.getByRole("button", { name: "Confirm and sign transfer" })).toHaveCount(0);
  await expect(section.locator("article")).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});
