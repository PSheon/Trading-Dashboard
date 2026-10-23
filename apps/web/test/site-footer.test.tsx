import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { SiteFooter } from "@/components/shell/site-footer";
import { catalogs } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { LOCALES } from "@/i18n/config";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }), usePathname: () => "/" }));
vi.mock("@/components/shell/language-menu", () => ({ LanguageMenu: ({ trigger }: { trigger: React.ReactNode }) => trigger }));

/** 2026-10-23: the footer listed "Email · coming soon" as a dead row. A
 * channel that does not exist is not listed. */
it.each(LOCALES)("lists no placeholder channel in the %s footer", (locale) => {
  const html = renderToStaticMarkup(<I18nProvider locale={locale} messages={catalogs[locale]}><SiteFooter /></I18nProvider>);
  expect(html).not.toMatch(/coming soon|即將推出|即将推出/i);
  expect(html).not.toContain(" · ");
  // The two columns that exist link somewhere.
  expect(html).toContain('href="https://x.com/');
  expect(html).toContain('href="https://t.me/');
});

it("keeps no key for the placeholder row", () => {
  const footer = catalogs["zh-TW"].home.footer as Record<string, string>;
  expect(footer.soon).toBeUndefined();
  expect(footer.email).toBeUndefined();
});
