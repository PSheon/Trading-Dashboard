import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, signIn } from "./helpers";

for (const width of [1440, 390]) test(`main withdrawal form displays its network and blocks unavailable signing at ${width}px`, async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/portfolio?wallet=funded");
  await signIn(page);
  await page.getByRole("button", { name: "Withdraw", exact: true }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Testnet");
  await expect(dialog).toContainText("Only withdraw USDC to Arbitrum Sepolia · $1 network fee");
  await dialog.getByLabel("Destination Address", { exact: true }).fill(`0x${"22".repeat(20)}`);
  await dialog.getByLabel("Amount (USDC)", { exact: true }).fill("12.5");
  await expect(dialog).toContainText("You receive $11.50");
  await expect(dialog.getByRole("button", { name: "Withdraw", exact: true })).toBeDisabled();
  await expectNoSidewaysScroll(page);
});
