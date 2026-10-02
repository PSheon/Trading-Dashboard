import { expect, test } from "@playwright/test";

/** What a crawler is served: one title, description, canonical URL and
 * <h1> per page, in the structure copydog.xyz uses, plus robots.txt, the
 * sitemap, the manifest and real 404s. */
test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

const PUBLIC = [
  { path: "/", title: "Hyperliquid Copy Trading | Orbie" },
  { path: "/explore", title: "Explore | Orbie" },
  { path: "/coins", title: /\| Orbie$/ },
  { path: "/insights", title: /\| Orbie$/ },
  { path: "/about", title: /\| Orbie$/ },
  { path: "/help", title: /\| Orbie$/ },
  { path: "/privacy", title: "Privacy Policy | Orbie" },
  { path: "/terms", title: "Terms of Use | Orbie" },
];

test("public pages have their own title, description, canonical URL and one h1, at both widths", async ({ page }) => {
  test.setTimeout(120000);
  const descriptions = new Set<string>();
  for (const { path, title } of PUBLIC) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      await expect(page).toHaveTitle(title);
      await expect(page.locator("h1"), `${path} at ${width}`).toHaveCount(1);
      // Whichever layout is shown, assistive technology finds one level-1 heading.
      await expect(page.getByRole("heading", { level: 1 }).filter({ visible: true }), `${path} at ${width}`).toHaveCount(1);
    }
    expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toBe(`https://app.orbie.fun${path === "/" ? "" : path}`);
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toBe("index, follow, max-image-preview:large, max-snippet:-1");
    const description = await page.locator('meta[name="description"]').getAttribute("content");
    expect(description, path).toBeTruthy();
    descriptions.add(description!);
    expect(await page.locator('meta[property="og:title"]').getAttribute("content")).toBe(await page.title());
    const types = await page.locator('script[type="application/ld+json"]').evaluateAll((nodes) => nodes.flatMap((node) => { const data = JSON.parse(node.textContent ?? "{}"); return data["@graph"] ? data["@graph"].map((item: { "@type": string }) => item["@type"]) : [data["@type"]]; }));
    expect(types.slice(0, 3)).toEqual(["Organization", "WebSite", "SoftwareApplication"]);
    if (path === "/about") expect(types).toContain("WebPage");
    if (path === "/help") expect(types).toContain("FAQPage");
  }
  expect(descriptions.size).toBe(PUBLIC.length);
});

test("personal pages are noindex; /admin and /dev are disallowed and noindex", async ({ page, request }) => {
  for (const path of ["/favorites", "/portfolio", "/settings"]) {
    await page.goto(path);
    expect(await page.locator('meta[name="robots"]').getAttribute("content"), path).toBe("noindex, follow");
  }
  for (const path of ["/admin", "/dev"]) {
    await page.goto(path);
    expect(await page.locator('meta[name="robots"]').first().getAttribute("content"), path).toBe("noindex, nofollow");
  }
  const robots = await (await request.get("/robots.txt")).text();
  for (const line of ["User-Agent: *", "Disallow: /admin", "Disallow: /dev", "Disallow: /api/", "Disallow: /portfolio", "Sitemap: https://app.orbie.fun/sitemap.xml"]) expect(robots).toContain(line);
});

test("sitemap.xml and the manifest are served", async ({ page, request }) => {
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  for (const path of ["/", "/explore", "/coins", "/insights", "/about", "/help", "/privacy", "/terms"]) expect(xml).toContain(`<loc>https://app.orbie.fun${path}</loc>`);
  for (const path of ["/admin", "/dev", "/settings", "/portfolio", "/favorites"]) expect(xml).not.toContain(`https://app.orbie.fun${path}`);

  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  const manifest = await (await request.get(href!)).json();
  expect(manifest).toMatchObject({ short_name: "Orbie", display: "standalone" });
  for (const icon of manifest.icons) {
    const image = await request.get(icon.src);
    expect(image.status(), icon.src).toBe(200);
    expect(image.headers()["content-type"]).toBe("image/png");
  }
});

test("a URL that is nothing, a malformed address and a malformed coin are real 404s with the 404's own title", async ({ page }) => {
  for (const path of ["/no-such-page", "/a/b/c", "/trader/0x1234", "/coins/a%20b", "/explore/all"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "404" })).toBeVisible();
    await expect(page, path).toHaveTitle("Page not found | Orbie");
    expect(await page.locator('meta[name="robots"]').getAttribute("content"), path).toBe("noindex");
  }
});

test("the FAQ is questions that open in place, one at a time", async ({ page }) => {
  await page.goto("/help");
  const questions = page.getByRole("main").locator("button[aria-expanded]");
  expect(await questions.count()).toBeGreaterThan(10);
  await expect(questions.first()).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("main").locator('button[aria-expanded="true"]')).toHaveCount(1);
  const first = page.locator(`[id="${await questions.first().getAttribute("aria-controls")}"]`);
  const second = page.locator(`[id="${await questions.nth(1).getAttribute("aria-controls")}"]`);
  await expect(first).toBeVisible();
  await expect(second).toBeHidden();
  await questions.nth(1).click();
  await expect(second).toBeVisible();
  await expect(first).toBeHidden();
  await expect(page.getByRole("main").locator('button[aria-expanded="true"]')).toHaveCount(1);
  // Keyboard: the question is a button.
  await questions.nth(2).focus();
  await page.keyboard.press("Enter");
  await expect(questions.nth(2)).toHaveAttribute("aria-expanded", "true");
  await expect(second).toBeHidden();
});
