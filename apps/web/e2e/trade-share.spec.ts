import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { shot, signIn } from "./helpers";

const address = "0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f";
test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

/** Every style × format of the open dialog downloads a real PNG of the
 * card's size (the server renders it; 2× the 640 × 360 / 480 × 600 design). */
async function downloadsEveryCard(page: Page, name: string) {
  const dialog = page.getByRole("dialog");
  for (const label of ["App Card · 16:9", "Poster · 16:9", "App Card · 4:5", "Poster · 4:5"]) await expect(dialog.getByRole("radio", { name: label, exact: true })).toBeVisible();
  for (const [label, w, h] of [["App Card · 16:9", 1280, 720], ["Poster · 4:5", 960, 1200]] as const) {
    await dialog.getByRole("radio", { name: label, exact: true }).click();
    await expect(dialog.getByRole("radio", { name: label, exact: true })).toHaveAttribute("aria-checked", "true");
    const save = dialog.getByRole("button", { name: "Download", exact: true });
    await expect(save).toBeEnabled({ timeout: 20_000 });
    await shot(page, `${name}-${label.replace(/\W+/g, "-")}`);
    const download = page.waitForEvent("download");
    await save.click();
    const png = await readFile((await (await download).path())!);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(w);
    expect(png.readUInt32BE(20)).toBe(h);
  }
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test("a trader's position: App Card and Poster in both formats, server-rendered PNGs", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/trader/${address}`);
  await page.getByRole("button", { name: "Share position", exact: true }).filter({ visible: true }).first().click();
  await expect(page.getByRole("dialog", { name: "Share Position" })).toBeVisible();
  await downloadsEveryCard(page, "share-position");
});

test("one of my paper copy trades, from Insights' best trades, at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/portfolio");
  await signIn(page);
  await page.getByRole("tab", { name: "Insights" }).filter({ visible: true }).click();
  await page.getByRole("button", { name: "Share trade", exact: true }).filter({ visible: true }).first().click();
  await expect(page.getByRole("dialog", { name: "Share Trade" })).toBeVisible();
  await downloadsEveryCard(page, "share-copy-trade-390");
});
