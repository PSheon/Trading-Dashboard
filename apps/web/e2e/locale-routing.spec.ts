import { expect, test } from "@playwright/test";

/** The language is in the URL (`/<locale>/…`, always), as DonutMe's is. */

test("an unprefixed URL goes to the saved language, then the browser's, keeping the query", async ({ browser, baseURL }) => {
  const japanese = await browser.newContext({ locale: "ja-JP" });
  const page = await japanese.newPage();
  // Explore writes its own canonical query (sort=pnl with 30d) once it renders.
  await page.goto("/explore?sort=pnl&window=30d");
  await expect(page).toHaveURL(`${baseURL}/ja/explore?sort=pnl&window=30d`);
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  // A saved choice outranks the browser.
  await japanese.addCookies([{ name: "locale", value: "ko", url: baseURL! }]);
  await page.goto("/trader/0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f");
  await expect(page).toHaveURL(`${baseURL}/ko/trader/0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f`);
  await japanese.close();

  // Neither: zh-TW.
  const none = await browser.newContext({ locale: "fr-FR" });
  const other = await none.newPage();
  await other.goto("/");
  await expect(other).toHaveURL(`${baseURL}/zh-TW`);
  await none.close();
});

test("the language menu moves the same page to the new prefix and saves the choice", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/en/explore?sort=pnl&window=30d");
  await page.getByRole("button", { name: "Language" }).first().click();
  await page.getByRole("menuitemradio", { name: "日本語" }).click();
  await expect(page).toHaveURL(`${baseURL}/ja/explore?sort=pnl&window=30d`);
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  expect((await context.cookies()).find((c) => c.name === "locale")?.value).toBe("ja");
  // Links stay in the new language.
  await expect(page.locator('a[href*="/trader/"]').first()).toHaveAttribute("href", /^\/ja\/trader\//);
});

test("every page names its eleven languages and x-default, and links stay in its language", async ({ page }) => {
  await page.goto("/zh-TW/coins");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://app.orbie.fun/zh-TW/coins");
  await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(12);
  await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute("href", "https://app.orbie.fun/en/coins");
  await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute("href", "https://app.orbie.fun/coins");
  const hrefs = await page.locator("a[href^='/']").evaluateAll((links) => links.map((link) => link.getAttribute("href")!));
  expect(hrefs.length).toBeGreaterThan(5);
  expect(hrefs.filter((href) => !href.startsWith("/zh-TW"))).toEqual([]);
});

test("a missing page under a locale is a 404 in that language; the api and images stay unprefixed", async ({ page, request }) => {
  const response = await page.goto("/zh-TW/no-such-page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "404" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
  for (const path of ["/robots.txt", "/sitemap.xml", "/opengraph-image"]) {
    const answer = await request.get(path, { maxRedirects: 0 });
    expect(answer.status(), path).toBe(200);
  }
  // The api forwarder answers itself (the test server has no api behind
  // it), never with a locale redirect.
  const api = await request.get("/api/hl/settings", { maxRedirects: 0 });
  expect(api.headers().location).toBeUndefined();
  expect(api.status()).not.toBe(307);
  // An old admin bookmark under a locale.
  await page.context().addCookies([{ name: "locale", value: "en", url: page.url() }]);
  const old = await request.get("/en/admin/revenue", { maxRedirects: 0 });
  expect(old.headers().location).toMatch(/\/en\/admin$/);
});
