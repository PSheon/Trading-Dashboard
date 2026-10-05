import { firstTraderLink, openFirstTrader, signIn, wcag } from "./helpers";
import { test, expect } from '@playwright/test';
for (const width of [1280, 390]) {
  test(`public discovery and trader accessibility at ${width}px`, async ({ page, context, baseURL }) => {
    // First in the run: on a cold dev server it also pays for compiling the
    // explore and trader pages (15 s locally, past the 30 s default in CI).
    test.setTimeout(90000);
    await context.addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/en/explore');
    await expect(firstTraderLink(page)).toBeVisible();
    const discovery = await (await wcag(page)).analyze();
    expect.soft(discovery.violations).toEqual([]);
    await openFirstTrader(page);
    await expect(page.getByRole(width < 768 ? 'radiogroup' : 'tablist', { name: 'Trading activity' })).toBeVisible();
    const profile = await (await wcag(page)).analyze();
    expect(profile.violations).toEqual([]);
  });
}
test('activity tabs support arrow, Home and End keys', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
  await page.goto('/en/explore');
  await openFirstTrader(page);
  const tabs = page.getByRole('tablist', { name: 'Trading activity' }).getByRole('tab');
  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(tabs.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tabs.first()).toBeFocused();
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', await tabs.first().getAttribute('id') ?? 'missing');
});
test('signed-in settings and user administration accessibility', async ({ page, context, baseURL }) => {
  test.setTimeout(60000);
  await context.addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
  await page.goto('/en/admin/users');
  await signIn(page);
  await expect(page.getByRole('table')).toBeVisible();
  for (const path of ['/en/admin/users', '/en/settings', '/en/admin/settings']) {
    await page.goto(path);
    await expect(page.getByRole('main')).toBeVisible();
    // Wait for fixture queries to settle rather than scanning skeleton-only UI.
    await page.waitForLoadState('networkidle');
    const result = await (await wcag(page)).analyze();
    expect.soft(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })), path).toEqual([]);
  }
});
