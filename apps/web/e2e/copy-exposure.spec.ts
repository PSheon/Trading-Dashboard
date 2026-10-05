import { expect, test } from "@playwright/test";
import { expectNoSidewaysScroll, signIn } from "./helpers";

for (const width of [1440, 390]) test(`copy exposure separates gross and net at ${width}px`, async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/en/portfolio");
  await signIn(page);
  await page.getByRole("tab", { name: "Exposure", exact: true }).filter({ visible: true }).click();
  for (const text of ["Direction", "Net exposure", "Signed net", "Leverage", "Gross = long + short; net = |long − short|. Amounts are USD notionals."]) {
    await expect(page.getByText(text, { exact: true }).filter({ visible: true }).first()).toBeVisible();
  }
  await expect(page.getByText("Each copy retains its own collateral and liquidation risk. Opposing positions do not share margin.").filter({ visible: true })).toBeVisible();
  await expectNoSidewaysScroll(page);
});
