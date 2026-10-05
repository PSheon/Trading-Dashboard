import { expect, test } from "@playwright/test";
import { shot } from "./helpers";

const address = "0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f";
test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

for (const width of [1440, 390]) test(`hovering the trader chart shows the positions held then (chart snapshots) at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/en/trader/${address}`);
  const strip = page.getByTestId("chart-snapshot").filter({ visible: true });
  await expect(strip).toContainText("Hover the chart", { timeout: 20_000 });
  const chart = page.getByRole("img", { name: /PnL/ }).filter({ visible: true }).first();
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
  await expect(strip).toContainText("Positions at");
  await shot(page, `chart-snapshot-${width}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 200);
  await expect(strip).toContainText("Hover the chart");
});
