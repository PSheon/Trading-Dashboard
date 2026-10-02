import type { Metadata, Viewport } from "next";
import { Fredoka, Geist_Mono, Host_Grotesk } from "next/font/google";
import "./globals.css";

import { AppProviders } from "@/components/app-providers";
import { AppShell } from "@/components/shell/app-shell";
import { OG_LOCALES } from "@/i18n/config";
import { getLocale, getMessages } from "@/i18n/server";
import { JsonLd } from "@/components/json-ld";
import { APP_NAME, APP_URL } from "@/lib/config";
import { siteJsonLd } from "@/lib/seo";

/** CopyDog's text face: the variable file (300–800), Latin only; CJK falls
 * through to the system stack in globals.css. Self-hosted at build time, with
 * next/font's size-adjusted fallback so the swap does not move the layout. */
const hostGrotesk = Host_Grotesk({
  variable: "--font-host-grotesk",
  subsets: ["latin"],
  display: "swap",
});

/** Wordmark only (Stage 2 §9: Fredoka 600). */
const fredoka = Fredoka({
  variable: "--font-fredoka",
  subsets: ["latin"],
  weight: "600",
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
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
  themeColor: "#0f0d1f",
  colorScheme: "dark",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  const messages = getMessages(locale);

  return (
    <html
      lang={locale}
      className={`dark ${hostGrotesk.variable} ${fredoka.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-background text-foreground">
        <JsonLd data={siteJsonLd(messages)} />
        <AppProviders locale={locale} messages={messages}>
          <AppShell>{children}</AppShell>
        </AppProviders>
      </body>
    </html>
  );
}
