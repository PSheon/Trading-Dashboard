import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
for (const width of [1280, 390]) {
  test(`public discovery and trader accessibility at ${width}px`, async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/explore');
    const trader = page.locator('a[href^="/trader/"]').first();
    await expect(trader).toBeVisible();
    const discovery = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect.soft(discovery.violations).toEqual([]);
    await trader.click();
    await expect(width < 768
      ? page.getByRole('radiogroup', { name: 'Trading activity' })
      : page.getByRole('tablist')).toBeVisible();
    const profile = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(profile.violations).toEqual([]);
  });
}
test('activity tabs support arrow, Home and End keys', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'locale', value: 'en', url: baseURL! }]);
  await page.goto('/explore');
  await page.locator('a[href^="/trader/"]').first().click();
  const tabs = page.getByRole('tab');
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
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Demo login', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  for (const path of ['/admin/users', '/settings', '/admin/settings']) {
    await page.goto(path);
    await expect(page.getByRole('main')).toBeVisible();
    // Wait for fixture queries to settle rather than scanning skeleton-only UI.
    await page.waitForLoadState('networkidle');
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect.soft(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })), path).toEqual([]);
  }
});
