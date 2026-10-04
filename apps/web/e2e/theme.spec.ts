import { expect, test } from "@playwright/test";

/** Light and dark (Orbit): the default follows the system, the header
 * button switches and remembers the choice across a reload (the server
 * renders the class from the cookie), and both themes fit phones and
 * desktops without sideways scroll. */
test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

const ground = (page: import("@playwright/test").Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const LIGHT = "rgb(251, 246, 238)";
const DARK = "rgb(21, 19, 43)";

test("with no choice the page follows the system theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect.poll(() => ground(page)).toBe(DARK);
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => ground(page)).toBe(LIGHT);
  expect(await page.evaluate(() => document.documentElement.className)).not.toMatch(/\b(light|dark)\b/);
});

test("the header theme button switches the theme and the choice survives a reload", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect.poll(() => ground(page)).toBe(LIGHT);
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect.poll(() => ground(page)).toBe(DARK);
  expect((await context.cookies()).find((c) => c.name === "theme")?.value).toBe("dark");
  // The server paints the chosen theme: the class is in the first HTML.
  const html = await (await page.request.get("/explore")).text();
  expect(html).toMatch(/<html[^>]*class="[^"]*\bdark\b/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect.poll(() => ground(page)).toBe(DARK);
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveClass(/\blight\b/);
  await expect.poll(() => ground(page)).toBe(LIGHT);
});

test("the phone menu offers system, light and dark", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/about");
  await page.getByRole("button", { name: "Open menu" }).click();
  const group = page.getByRole("radiogroup", { name: "Theme" });
  await group.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await group.getByRole("radio", { name: "System" }).click();
  await expect(page.locator("html")).not.toHaveClass(/\b(light|dark)\b/);
  expect((await context.cookies()).find((c) => c.name === "theme")).toBeUndefined();
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1440]) {
    test(`${theme} theme fits at ${width}px on the main pages`, async ({ page, context, baseURL }) => {
      test.setTimeout(90000);
      await context.addCookies([{ name: "theme", value: theme, url: baseURL! }]);
      await page.setViewportSize({ width, height: 900 });
      for (const path of ["/", "/explore", "/insights", "/coins", "/trader/0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f", "/about"]) {
        await page.goto(path);
        await expect.poll(() => ground(page), path).toBe(theme === "dark" ? DARK : LIGHT);
        await expect(page.locator("main")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${path} scrolls sideways`).toBeLessThanOrEqual(0);
      }
    });
  }
}
