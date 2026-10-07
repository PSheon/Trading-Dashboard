import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, shot } from "./helpers";

for (const width of [1440, 390, 320]) test(`account mode controls funds, portfolio and copy together at ${width}px`, async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await context.addInitScript(() => localStorage.setItem("fixture-signed-in", "1"));
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/en/portfolio?signer=fixture&wallet=funded");
  const account = page.getByRole("button", { name: "Account", exact: true }).and(page.locator('[aria-haspopup="menu"]')).filter({ visible: true });
  await expect(account).toContainText("Paper");
  await expect(page.locator('[data-view="paper"]').filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deposit", exact: true }).filter({ visible: true })).toHaveCount(0);
  await page.goto("/en/settings?tab=funds&view=history");
  await expect(page.getByRole("button", { name: /^(Deposit|Withdraw)$/ }).filter({ visible: true })).toHaveCount(0);
  await account.click();
  const unavailable = page.getByRole("menuitemradio", { name: /Live/ });
  await expect(unavailable).toBeDisabled();
  await expect(unavailable).toContainText("Not enabled");
  await page.getByRole("menuitemradio", { name: "Testnet", exact: true }).click();
  await expect(account).toContainText("Testnet");
  await page.goto("/en/portfolio");
  await expect(page.locator('[data-testid="my-funds"]').filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^(Paper|Live|Testnet)$/ })).toHaveCount(0);
  await page.goto("/en/trader/0xbf732ea04197942783e34730ed6e0f6099575d58");
  const traderAccount = page.getByRole("button", { name: "Account", exact: true }).and(page.locator('[aria-haspopup="menu"]')).filter({ visible: true });
  await expect(traderAccount).toContainText("Testnet");
  await traderAccount.click();
  await page.getByRole("menuitemradio", { name: "Paper", exact: true }).click();
  if (width < 768) await page.getByTestId("trader-copy-bar").getByRole("button").click();
  await expect(page.getByRole("radiogroup", { name: "Copy mode" })).toHaveCount(0);
  await expectNoSidewaysScroll(page);
  await shot(page, `global-mode-${width}`);
});

for (const path of ["/", "/explore", "/portfolio", "/favorites", "/settings", "/trader/0xbf732ea04197942783e34730ed6e0f6099575d58"]) test(`phone footer links stay above floating navigation at ${path}`, async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await context.addInitScript(() => localStorage.setItem("fixture-signed-in", "1"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/en${path === "/" ? "" : path}`);
  const footer = page.locator("footer").filter({ visible: true });
  await expect(footer.getByRole("link", { name: "Privacy policy", exact: true })).toBeVisible();
  await footer.scrollIntoViewIfNeeded();
  const floating = page.locator(".phone-floating-bar").filter({ visible: true });
  // Explore rows can finish loading after the footer is visible. Measure
  // at the settled page end, rather than at the old skeleton's scroll end.
  await expect.poll(async () => {
    await page.evaluate(async () => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const legal = await footer.getByRole("link", { name: "Terms of use", exact: true }).boundingBox();
    const bar = await floating.boundingBox();
    return legal!.y + legal!.height - bar!.y;
  }).toBeLessThanOrEqual(0);
  await expectNoSidewaysScroll(page);
});
