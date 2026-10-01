import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/** Signs in to the fixture account. The desktop top bar has the demo login
 * button; a phone has no top bar on most pages (as on CopyDog), so the
 * page's own sign-in prompt is the way in. */
export async function signIn(page: Page) {
  await page.getByRole("button", { name: /^(Demo login|Sign In)$/ }).filter({ visible: true }).first().click();
}

/** Explore renders the grid cards and the phone list together and hides
 * one of them, so the first trader link in the DOM is not always visible. */
export function firstTraderLink(page: Page) {
  return page.locator('a[href^="/trader/"]').filter({ visible: true }).first();
}

/** Opens the first trader from /explore and waits for the route change;
 * the dev server may still be compiling the trader page. */
export async function openFirstTrader(page: Page) {
  await firstTraderLink(page).click();
  await expect(page).toHaveURL(/\/trader\/0x/, { timeout: 20000 });
}

/** A WCAG 2.1 A/AA scan of the page's settled look. Transitions are turned
 * off first: a button fading between its disabled and enabled states (a
 * refresh button while a query refetches, say) would otherwise be read
 * mid-fade and fail contrast with a colour the page never rests on. */
export async function wcag(page: Page) {
  await page.evaluate(() => {
    if (document.getElementById("e2e-no-transitions")) return;
    const style = document.createElement("style");
    style.id = "e2e-no-transitions";
    style.textContent = "*,*::before,*::after{transition:none!important}";
    document.head.append(style);
  });
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]);
}
