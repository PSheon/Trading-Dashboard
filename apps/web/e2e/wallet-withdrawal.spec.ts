import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, signIn } from "./helpers";

for (const width of [1440, 390]) test(`main withdrawal form displays its network and blocks unavailable signing at ${width}px`, async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await page.setViewportSize({ width, height: 900 });
  // The main wallet is on the real-money view (正式); this build opens on 模擬.
  await page.goto("/en/portfolio?wallet=funded&view=real");
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

// `?signer=fixture` gives the fixture account a fixed-signature wallet
// (lib/fixture-signer.ts), so the whole journey runs: reserve, sign,
// broadcast claim, submit, the result toast and the modal closing.
for (const width of [1440, 390]) test(`a main withdrawal is signed, submitted and confirmed, and the modal closes at ${width}px`, async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/en/portfolio?wallet=funded&signer=fixture&view=real");
  await signIn(page);
  await page.getByRole("button", { name: "Withdraw", exact: true }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Destination Address", { exact: true }).fill(`0x${"22".repeat(20)}`);
  await dialog.getByLabel("Amount (USDC)", { exact: true }).fill("12.5");
  const submit = dialog.getByRole("button", { name: "Withdraw", exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByText("Withdrawal submission accepted. Arrival on Arbitrum is awaiting confirmation.")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expectNoSidewaysScroll(page);
});

test("an exchange refusal says so and leaves the form for a new withdrawal", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await page.goto("/en/portfolio?wallet=funded&signer=fixture&withdraw=rejected");
  await signIn(page);
  await page.getByRole("button", { name: "Withdraw", exact: true }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Destination Address", { exact: true }).fill(`0x${"22".repeat(20)}`);
  await dialog.getByLabel("Amount (USDC)", { exact: true }).fill("12.5");
  await dialog.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(page.getByText("The exchange rejected this withdrawal. Review the available balance and create a new withdrawal.")).toBeVisible();
  // Nothing is pending afterwards: the form is open for a new attempt.
  await expect(dialog.getByLabel("Amount (USDC)", { exact: true })).toBeEnabled();
});
