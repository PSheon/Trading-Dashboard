import { expect, test, type Page } from "@playwright/test";
import { expectNoSidewaysScroll, signIn } from "./helpers";

const TRADER = "/en/trader/0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f";

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
});

/** Paul, 2026-10-05: 投資組合 / 收藏 are not in the header while signed out
 * (desktop capsule, phone tab bar and ☰ menu); they appear once signed in. */
test("the signed-out header has no Portfolio / Saved; signing in shows them", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/en/explore");
  const header = page.locator("header.orbit-header");
  await expect(header.getByRole("button", { name: "Demo login" })).toBeVisible();
  await expect(header.getByRole("navigation", { name: "Mine" })).toHaveCount(0);
  await expect(header.getByRole("link", { name: /^(Portfolio|Saved)$/ })).toHaveCount(0);
  await expect(header.getByRole("link", { name: "Explore" })).toBeVisible();

  await signIn(page);
  await expect(header.getByRole("navigation", { name: "Mine" })).toBeVisible();
  await expect(header.getByRole("link", { name: "Portfolio" })).toBeVisible();
  await expect(header.getByRole("link", { name: "Saved" })).toBeVisible();
});

test("the phone tab bar and menu offer Portfolio / Saved only when signed in", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/en");
  const tabs = page.getByRole("navigation", { name: "Main navigation" }).filter({ visible: true });
  await expect(tabs.getByRole("link")).toHaveText(["Home", "Explore", "Insights"]);

  await page.goto("/en/help");
  await page.getByRole("button", { name: "Open menu" }).click();
  const menu = page.getByRole("dialog");
  await expect(menu.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(menu.getByRole("link", { name: /^(Portfolio|Saved)$/ })).toHaveCount(0);

  await page.goto("/en");
  await signIn(page);
  await expect(tabs.getByRole("link")).toHaveText(["Home", "Explore", "Saved", "Portfolio"]);
});

for (const signedIn of [false, true]) {
  test(`phone main pages keep search, account and header fade (signed in: ${signedIn})`, async ({ page, context }) => {
    if (signedIn) await context.addInitScript(() => localStorage.setItem("fixture-signed-in", "1"));
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["explore", "favorites", "portfolio", "insights"]) {
      await page.goto(`/en/${path}`);
      const header = page.getByTestId("app-phone-header");
      await expect(header).toBeVisible();
      await expect(header.getByRole("link", { name: "Orbie", exact: true })).toBeVisible();
      await expect(header.getByRole("button", { name: "Search name, X handle or address" })).toBeVisible();
      await expect(header.getByRole("button", { name: signedIn ? "Account" : "Demo login", exact: true })).toBeVisible();
      const title = page.getByRole("heading", { level: 1 }).filter({ visible: true });
      expect((await title.boundingBox())!.y).toBeGreaterThanOrEqual((await header.boundingBox())!.height);
      await expect(page.getByRole("navigation", { name: "Main navigation" }).filter({ visible: true })).toBeVisible();
      await expectNoSidewaysScroll(page);
      await page.setViewportSize({ width: 320, height: 844 });
      const narrowControls = await header.locator("a,button").evaluateAll(elements => elements.map(el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
      for (const bounds of narrowControls) {
        expect(bounds.left).toBeGreaterThanOrEqual(12);
        expect(bounds.right).toBeLessThanOrEqual(308);
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.height).toBeGreaterThanOrEqual(44);
      }
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page.goto("/en/explore");
    const header = page.getByTestId("app-phone-header");
    await header.getByRole("button", { name: "Search name, X handle or address" }).click();
    const input = page.getByRole("combobox", { name: "Search name, X handle or address" }).filter({ visible: true });
    await expect(input).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(input).toBeHidden();
    await page.evaluate(() => window.scrollTo(0, 250));
    await expect.poll(() => header.locator(".bar-scrim").evaluate(el => getComputedStyle(el).opacity)).toBe("1");
    expect(await header.evaluate(el => el.getBoundingClientRect().y)).toBe(0);
  });
}

/** The header's contents, the page's content and the footer share one
 * frame: their left and right edges are the same at every width. */
async function edges(page: Page) {
  return page.evaluate(() => {
    const inner = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width) return null;
      const cs = getComputedStyle(el);
      return [Math.round(r.left + parseFloat(cs.paddingLeft)), Math.round(r.right - parseFloat(cs.paddingRight))];
    };
    const outer = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width ? [Math.round(r.left), Math.round(r.right)] : null;
    };
    const desktop = document.querySelector("header.orbit-header .page-frame");
    const phone = [...document.querySelectorAll("header")].find((h) => !h.classList.contains("orbit-header") && h.getBoundingClientRect().width > 0) ?? null;
    return {
      header: inner(desktop) ?? inner(phone),
      main: inner(document.querySelector("main")),
      footer: outer([...document.querySelectorAll("footer")].find((f) => f.getBoundingClientRect().width > 0) ?? null),
      sideways: document.documentElement.scrollWidth - innerWidth,
    };
  });
}

for (const width of [390, 1440, 1920]) {
  test(`header, content and footer edges line up at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/en", "/en/explore", "/en/coins", TRADER, "/en/about"]) {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      const e = await edges(page);
      expect(e.main, `${path} main`).not.toBeNull();
      if (e.header) expect(e.header, `${path} header`).toEqual(e.main);
      if (e.footer) expect(e.footer, `${path} footer`).toEqual(e.main);
      expect(e.sideways, `${path} sideways scroll`).toBeLessThanOrEqual(0);
      if (width >= 1440) expect(e.main![1] - e.main![0], `${path} frame width`).toBe(1400);
    }
  });
}
