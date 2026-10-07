import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, signIn } from "./helpers";

for (const width of [1440, 390]) test(`execution wallet settings explain unavailable preparation at ${width}px`, async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(width < 768 ? "/en/settings?view=account" : "/en/settings?tab=account");
  await signIn(page);
  if (width < 768) {
    await expect(page.getByTestId("phone-settings")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  }
  // One-click copy replaced these forms in Settings; they live in the lab.
  await expect(page.getByRole("region", { name: "Copy execution wallets" })).toHaveCount(0);
  await page.goto("/en/dev/copy");
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
  await expect(funding).toContainText("Once it is credited and the copy consent is signed, copying starts on testnet. Your paper balance does not change.");
  await expect(funding.getByRole("button", { name: "Confirm and sign transfer" })).toHaveCount(0);
  // Demo authentication never supplies authority for the real account lifecycle or ledger.
  for (const name of ["Strategy agent approval", "Strategy account mode", "Actual follower statement"]) {
    await expect(page.getByRole("region", { name, exact: true, includeHidden: true })).toHaveCount(0);
  }
  for (const name of ["Prepare agent", "Confirm and sign approval", "Prepare account mode", "Confirm and sign mode consent"]) {
    await expect(section.getByRole("button", { name, exact: true, includeHidden: true })).toHaveCount(0);
  }
  await expect(section.getByText(/^(Delegation approved|Submission accepted|Standard mode observed)$/)).toHaveCount(0);
  await expect(section.locator("article")).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});
