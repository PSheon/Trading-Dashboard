import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

/** Signs in to the fixture account. The desktop top bar has the demo login
 * button; a phone has no top bar on most pages (as on CopyDog), so the
 * page's own sign-in prompt is the way in. */
export async function signIn(page: Page) {
  await page.getByRole("button", { name: /^(Demo login|Sign In)$/ }).filter({ visible: true }).first().click();
}

/** The first trader link on screen (explore mounts one layout per width;
 * other pages may still carry a hidden one). */
export function firstTraderLink(page: Page) {
  return page.locator('a[href*="/trader/"]').filter({ visible: true }).first();
}

/** Opens the first trader from /explore and waits for the route change;
 * the dev server may still be compiling the trader page. */
export async function openFirstTrader(page: Page) {
  await firstTraderLink(page).click();
  await expect(page).toHaveURL(/\/trader\/0x/, { timeout: 20000 });
}

/** A WCAG 2.1 A/AA scan of the page's settled look. Transitions are turned
 * and animations are settled first: a button fading between its disabled and enabled states (a
 * refresh button while a query refetches, say) would otherwise be read
 * mid-fade and fail contrast with a colour the page never rests on. */
export async function wcag(page: Page) {
  await page.evaluate(() => {
    if (document.getElementById("e2e-no-transitions")) return;
    const style = document.createElement("style");
    style.id = "e2e-no-transitions";
    // Entrance animations (Orbit's fades) jump to their end state too.
    style.textContent = "*,*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important}";
    document.head.append(style);
  });
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]);
}

/** A full-page screenshot for the person reviewing the run, in
 * E2E_SCREENSHOT_DIR (default /tmp) as `orbie-<name>.png`. */
export async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR ?? "/tmp"}/orbie-${name}.png`, fullPage: true });
}

/** The page fits its viewport: nothing scrolls sideways. */
export async function expectNoSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

/** No WCAG 2.1 A/AA violations on the settled page. */
export async function expectAccessible(page: Page) {
  const audit = await (await wcag(page)).analyze();
  expect(audit.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
}

/** Picks `value` in a shared Select (components/ui/select): opens it from
 * its combobox trigger and clicks the option carrying that value. */
export async function chooseOption(page: Page, trigger: Locator, value: string | { index: number }) {
  await trigger.click();
  const content = page.locator('[data-slot="select-content"]');
  const option = typeof value === "string" ? content.locator(`[data-value="${value}"]`) : content.locator("[data-value]").nth(value.index);
  await option.click();
  await expect(content).toHaveCount(0);
}

/** Saves the admin settings page: the 儲存 button of its "Changes on save" card. */
export async function saveSettings(page: Page) {
  await page.getByRole("region", { name: "Changes on save" }).getByRole("button", { name: "Save", exact: true }).click();
}
