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
      await page.goto(`/en${path === "/" ? "" : path}`);
      await expect(page).toHaveTitle(title);
      await expect(page.locator("h1"), `${path} at ${width}`).toHaveCount(1);
      // Whichever layout is shown, assistive technology finds one level-1 heading.
      await expect(page.getByRole("heading", { level: 1 }).filter({ visible: true }), `${path} at ${width}`).toHaveCount(1);
    }
    const bare = path === "/" ? "" : path;
    // The canonical URL is this language's; all eleven and x-default (the
    // unprefixed URL, which redirects to the visitor's language) alternate.
    expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toBe(`https://app.orbie.fun/en${bare}`);
    await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(12);
    expect(await page.locator('link[rel="alternate"][hreflang="zh-TW"]').getAttribute("href")).toBe(`https://app.orbie.fun/zh-TW${bare}`);
    expect(await page.locator('link[rel="alternate"][hreflang="x-default"]').getAttribute("href")).toBe(`https://app.orbie.fun${bare}`);
    expect(await page.locator('meta[property="og:url"]').getAttribute("content")).toBe(`https://app.orbie.fun/en${bare}`);
    expect(await page.locator("html").getAttribute("lang")).toBe("en");
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
  for (const path of ["/en/favorites", "/en/portfolio", "/en/settings"]) {
    await page.goto(path);
    expect(await page.locator('meta[name="robots"]').getAttribute("content"), path).toBe("noindex, follow");
  }
  for (const path of ["/en/admin", "/en/dev"]) {
    await page.goto(path);
    expect(await page.locator('meta[name="robots"]').first().getAttribute("content"), path).toBe("noindex, nofollow");
  }
  const robots = await (await request.get("/robots.txt")).text();
  for (const line of ["User-Agent: *", "Disallow: /admin", "Disallow: /dev", "Disallow: /en/admin", "Disallow: /zh-TW/dev", "Disallow: /ja/portfolio", "Disallow: /api/", "Allow: /api/hl/discover/", "Allow: /api/hl/traders", "Disallow: /api/hl/me", "Disallow: /api/hl/admin", "Disallow: /portfolio", "Sitemap: https://app.orbie.fun/sitemap.xml"]) expect(robots).toContain(line);
});

test("sitemap.xml and the manifest are served", async ({ page, request }) => {
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  // Every public page in every language, each naming the others.
  for (const path of ["", "/explore", "/coins", "/insights", "/about", "/help", "/privacy", "/terms"]) {
    for (const locale of ["en", "zh-TW", "ja"]) expect(xml).toContain(`<loc>https://app.orbie.fun/${locale}${path}</loc>`);
    expect(xml).toContain(`hreflang="ko" href="https://app.orbie.fun/ko${path}"`);
    expect(xml).toContain(`hreflang="x-default" href="https://app.orbie.fun${path || "/"}"`);
  }
  for (const path of ["/admin", "/dev", "/settings", "/portfolio", "/favorites"]) {
    expect(xml).not.toContain(`https://app.orbie.fun${path}`);
    expect(xml).not.toContain(`https://app.orbie.fun/en${path}`);
  }

  await page.goto("/en");
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
  for (const path of ["/en/no-such-page", "/en/a/b/c", "/en/trader/0x1234", "/en/coins/a%20b", "/en/explore/all", "/en/xx/yy"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "404" })).toBeVisible();
    await expect(page, path).toHaveTitle("Page not found | Orbie");
    expect(await page.locator('meta[name="robots"]').getAttribute("content"), path).toBe("noindex");
  }
});

/** The HTML as served, before any script runs (curl's view, and a crawler's
 * that doesn't run JavaScript): the 404's words and its own title are in
 * it, in the URL's language. Next 16 answers a `notFound()` thrown during
 * render with an empty `<html id="__next_error__">`; these come from the
 * proxy's status instead (lib/page-routes.ts). */
test("a 404 is in the served HTML, with its own title, in each language", async ({ request }) => {
  const cases = [
    { path: "/zh-TW/zz-no-such-page", title: "找不到頁面 | Orbie", body: "此頁面不存在。", home: "返回首頁" },
    { path: "/en/zz-no-such-page", title: "Page not found | Orbie", body: "This page doesn&#x27;t exist.", home: "Back to home" },
    { path: "/zh-TW/trader/0x1234", title: "找不到頁面 | Orbie", body: "此頁面不存在。", home: "返回首頁" },
    { path: "/en/a/b/c", title: "Page not found | Orbie", body: "This page doesn&#x27;t exist.", home: "Back to home" },
  ];
  for (const { path, title, body, home } of cases) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(404);
    const html = await response.text();
    expect(html, path).not.toContain('id="__next_error__"');
    const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((match) => match[1]);
    expect(titles[0], path).toBe(title);
    expect(titles.every((text) => text === title), `${path}: ${titles.join(" / ")}`).toBe(true);
    // The visible words, outside scripts (the RSC payload in a <script> would
    // match even when the HTML has none).
    const visible = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<template[\s\S]*?<\/template>/g, "");
    expect(visible, path).toMatch(/<h1[^>]*>404<\/h1>/);
    expect(visible, path).toContain(body);
    expect(visible, path).toContain(home);
    expect(visible, path).toContain('<meta name="robots" content="noindex"/>');
  }
});

test("the FAQ is questions that open in place, one at a time", async ({ page }) => {
  await page.goto("/en/help");
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
