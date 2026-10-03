import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const address = "0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f";
test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

test("position snapshot exports genuine PNGs in both formats", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/trader/${address}`);
  await page.getByRole("button", { name: "Share position", exact: true }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog");
  const image = dialog.locator("canvas");
  await expect(image).toHaveAttribute("width", "960");
  await expect(image).toHaveAttribute("height", "540");
  const frozen = await image.getAttribute("aria-label");
  for (const height of [540, 1200]) {
    if (height === 1200) await dialog.getByRole("radio", { name: "4:5", exact: true }).click();
    await expect(image).toHaveAttribute("height", String(height));
    await expect(image).toHaveAttribute("aria-label", frozen!);
    const save = dialog.getByRole("button", { name: "Download", exact: true });
    await expect(save).toBeEnabled();
    // Re-selecting the current format must not strand the canvas in loading.
    await dialog.getByRole("radio", { name: height === 540 ? "16:9" : "4:5", exact: true }).click();
    await expect(save).toBeEnabled();
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download", exact: true }).click();
    const png = await readFile((await (await download).path())!);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(960);
    expect(png.readUInt32BE(20)).toBe(height);
    expect(png.length).toBeGreaterThan(3000);
  }
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
