import type { Metadata, Viewport } from "next";
import { Fredoka, Noto_Sans_TC, Nunito } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";

import { AppProviders } from "@/components/app-providers";
import { AppShell } from "@/components/shell/app-shell";
import { OG_LOCALES } from "@/i18n/config";
import { getLocale, getMessages } from "@/i18n/server";
import { JsonLd } from "@/components/json-ld";
import { APP_NAME, APP_URL } from "@/lib/config";
import { siteJsonLd } from "@/lib/seo";
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

/** CJK after Nunito. Large: never preloaded; the browser fetches only the
 * unicode-range slices a page uses. `optional`: a first visit on a slow
 * connection keeps the system CJK face (PingFang / JhengHei / Noto CJK)
 * instead of re-painting every heading seconds later — that late swap was
 * the phone LCP (14 s in Lighthouse); the slices are cached for the next
 * page. */
const notoSansTc = Noto_Sans_TC({
  variable: "--font-noto-tc",
  weight: ["500", "700"],
  display: "optional",
  preload: false,
});

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const messages = getMessages(locale);
  // CopyDog's shape: "<page> | <site>", and the home page's own title as
  // the default.
  const title = `${messages.meta.homeTitle} | ${APP_NAME}`;
  return {
    metadataBase: new URL(APP_URL),
    applicationName: APP_NAME,
    title: { default: title, template: `%s | ${APP_NAME}` },
    description: messages.meta.description,
    openGraph: {
      type: "website",
      siteName: APP_NAME,
      url: "/",
      title,
      description: messages.meta.description,
      locale: OG_LOCALES[locale],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: messages.meta.description,
    },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark },
  ],
  colorScheme: "light dark",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  const messages = getMessages(locale);
  // The theme chosen with the toggle (cookie); none = follow the system.
  const themeChoice = parseThemeChoice((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <html
      lang={locale}
      className={`${themeClass(themeChoice)} ${nunito.variable} ${fredoka.variable} ${notoSansTc.variable} h-full antialiased`.trim()}
    >
      <body className="min-h-full bg-background text-foreground">
        <JsonLd data={siteJsonLd(messages)} />
        <AppProviders locale={locale} messages={messages} themeChoice={themeChoice}>
          <AppShell>{children}</AppShell>
        </AppProviders>
      </body>
    </html>
  );
}
