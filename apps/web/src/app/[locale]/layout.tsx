import type { Metadata, Viewport } from "next";
import { Fredoka, Nunito } from "next/font/google";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import "../globals.css";

import { AppProviders } from "@/components/app-providers";
import { AppShell } from "@/components/shell/app-shell";
import { CjkFontWarmup } from "@/components/shell/cjk-font";
import { ANNOUNCEMENT_COOKIE } from "@/lib/announcement";
import { CJK_FONT_COOKIE, parseCjkFont } from "@/lib/cjk-font";
import { clientAddress } from "@/lib/client-address";
import type { PublicSettings } from "@/lib/contracts";
import { prefetchPublic, type Prefetched } from "@/lib/server-prefetch";
import { OG_LOCALES, PATH_HEADER, isLocale } from "@/i18n/config";
import { getLocale, getMessages } from "@/i18n/server";
import { JsonLd } from "@/components/json-ld";
import { APP_NAME, APP_URL } from "@/lib/config";
import { localeAlternates, siteJsonLd } from "@/lib/seo";
import { THEME_COLOR, THEME_COOKIE, parseThemeChoice, themeClass } from "@/lib/theme";

/** Orbit's faces, self-hosted at build time with size-adjusted fallbacks so
 * the swap does not move the layout. Nunito: body and UI. */
const nunito = Nunito({
  variable: "--font-nunito",
  subsets: ["latin"],
  weight: ["500", "700", "800"],
  display: "swap",
});

/** Fredoka: numbers, headings and the wordmark. */
const fredoka = Fredoka({
  variable: "--font-fredoka",
  subsets: ["latin"],
  weight: ["500", "600"],
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const messages = getMessages(locale);
  // CopyDog's shape: "<page> | <site>", and the home page's own title as
  // the default.
  const title = `${messages.meta.homeTitle} | ${APP_NAME}`;
  // Every page's canonical URL and its eleven language versions; a page
  // with its own SEO (lib/seo.ts) writes the same from its own path.
  const path = (await headers()).get(PATH_HEADER);
  return {
    metadataBase: new URL(APP_URL),
    applicationName: APP_NAME,
    title: { default: title, template: `%s | ${APP_NAME}` },
    description: messages.meta.description,
    openGraph: {
      type: "website",
      siteName: APP_NAME,
      url: `/${locale}`,
      title,
      description: messages.meta.description,
      locale: OG_LOCALES[locale],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: messages.meta.description,
    },
    ...(path ? { alternates: localeAlternates(locale, path) } : {}),
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark },
  ],
  colorScheme: "light dark",
};

/** GET /settings for the banners' first frame (announcement, maintenance),
 * within a short budget: a slow api leaves them to the browser's read, as
 * before. Fixture mode answers from the sample data. */
async function siteSettings(): Promise<Prefetched<PublicSettings> | null> {
  if (process.env.NEXT_PUBLIC_API_FIXTURES === "1") {
    const { fixtureRequest } = await import("@/fixtures/handler");
    return { data: await fixtureRequest<PublicSettings>("GET", "/settings", undefined, null), fetchedAt: Date.now() };
  }
  return prefetchPublic<PublicSettings>("/settings", { client: clientAddress(await headers()), timeoutMs: SETTINGS_PREFETCH_MS });
}
const SETTINGS_PREFETCH_MS = 400;

/**
 * The root layout sits under `[locale]`: the URL's language is the page's
 * (`<html lang>`, the catalog, the metadata), and any other first segment
 * is a 404 (the proxy has already sent unprefixed page URLs to a locale).
 */
export default async function RootLayout({ children, params }: LayoutProps<"/[locale]">) {
  if (!isLocale((await params).locale)) notFound();
  const locale = await getLocale();
  const messages = getMessages(locale);
  // The theme chosen with the toggle (cookie); none = follow the system.
  const [cookieStore, settings] = await Promise.all([cookies(), siteSettings()]);
  const themeChoice = parseThemeChoice(cookieStore.get(THEME_COOKIE)?.value);
  // The CJK web font, once this browser has it cached (see CjkFontWarmup):
  // its stylesheet is linked and the family put first. A first visit's CSS
  // has none of it (components/shell/noto-font is imported only there).
  const cjkFont = parseCjkFont(cookieStore.get(CJK_FONT_COOKIE)?.value);

  return (
    <html
      lang={locale}
      className={`${themeClass(themeChoice)} ${nunito.variable} ${fredoka.variable}${cjkFont ? " cjk-web" : ""} h-full antialiased`.trim()}
      style={cjkFont ? ({ "--font-noto-tc": cjkFont.family } as React.CSSProperties) : undefined}
    >
      {cjkFont ? (
        <head>
          {cjkFont.css.map((href) => <link key={href} rel="stylesheet" href={href} precedence="cjk-font" />)}
        </head>
      ) : null}
      <body className="min-h-full bg-background text-foreground">
        <JsonLd data={siteJsonLd(locale, messages)} />
        <AppProviders locale={locale} messages={messages} themeChoice={themeChoice}>
          <AppShell settings={settings} announcementDismissed={cookieStore.get(ANNOUNCEMENT_COOKIE)?.value ?? null}>{children}</AppShell>
          <CjkFontWarmup />
        </AppProviders>
      </body>
    </html>
  );
}
