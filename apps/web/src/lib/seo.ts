// Server-only (reads the locale cookie through i18n/server).
import type { Metadata } from "next";

import { LOCALES, OG_LOCALES, localePath, splitLocale, type Locale } from "@/i18n/config";
import { getLocale, getMessages } from "@/i18n/server";
import type { Messages } from "@/i18n/messages";
import { APP_NAME, APP_URL, TELEGRAM_BOT_URL, X_HANDLE, X_URL } from "@/lib/config";
import { contentBlocks, splitTitle, type ContentPage } from "@/lib/content";
import { inlineText, type Block } from "@/lib/markdown";
import { ogAlt } from "@/lib/og-card";
import { withApp } from "@/lib/seo-text";

/** CopyDog's robots meta for a public page. */
const INDEXED = { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 } as const;
/** Personal pages (favorites, portfolio, settings): CopyDog's `noindex, follow`. */
const PRIVATE = { index: false, follow: true } as const;

export interface PageSeo {
  /** Without the site name; the root layout's template adds it. */
  title: string;
  description: string;
  /** The page's own path, without a locale: its canonical URL and `og:url`
   * are the current locale's, with the other languages as alternates. */
  path: string;
  /** false: a personal page, kept out of search results. */
  index?: boolean;
  /** The title is already complete (the home page). */
  absolute?: boolean;
  /** The link preview's image; the site card by default. */
  images?: OgImage[];
}

type OgImage = { url: string; width: number; height: number; alt: string; type: string };

/** The site's link-preview card (app/opengraph-image.tsx, outside the
 * locale tree so its URL never changes). */
const SITE_CARD: OgImage[] = [{ url: "/opengraph-image", width: 1200, height: 630, alt: ogAlt, type: "image/png" }];

/**
 * A page's canonical URL (its own language's) and its hreflang set: the
 * same path in each of the eleven languages, and `x-default` on the
 * unprefixed path, which sends a visitor to their own language. `path` may
 * carry a locale prefix (the proxy's path header) or not.
 */
export function localeAlternates(locale: Locale, path: string): NonNullable<Metadata["alternates"]> {
  const bare = splitLocale(path).path;
  return {
    canonical: localePath(locale, bare),
    languages: { ...Object.fromEntries(LOCALES.map((l) => [l, localePath(l, bare)])), "x-default": bare },
  };
}

/**
 * One page's head, in the structure CopyDog serves: its own title and
 * description, a canonical URL, robots, and the same pair repeated for
 * link previews. Open Graph and Twitter are written out in full because a
 * page's `openGraph` replaces the layout's rather than merging with it.
 */
export function pageSeo(locale: Locale, { title, description, path, index = true, absolute = false, images }: PageSeo): Metadata {
  const full = absolute ? title : `${title} | ${APP_NAME}`;
  return {
    title: absolute ? { absolute: title } : title,
    description,
    alternates: localeAlternates(locale, path),
    robots: index ? INDEXED : PRIVATE,
    openGraph: { type: "website", siteName: APP_NAME, url: localePath(locale, path), title: full, description, locale: OG_LOCALES[locale], images: images ?? SITE_CARD },
    twitter: { card: "summary_large_image", site: `@${X_HANDLE}`, creator: `@${X_HANDLE}`, title: full, description, images: images ?? SITE_CARD },
  };
}

/** `export const generateMetadata = seo("/explore", (m) => ({ title: m.discover.title, description: m.meta.pages.explore }))` */
export function seo(path: string, pick: (messages: Messages) => { title: string; description?: string; index?: boolean; absolute?: boolean }) {
  return async (): Promise<Metadata> => {
    const locale = await getLocale();
    const messages = getMessages(locale);
    const picked = pick(messages);
    return pageSeo(locale, { path, ...picked, description: withApp(picked.description ?? messages.meta.description) });
  };
}

/** A written page (docs/content): its `# title` and its catalog description. */
export function contentSeo(page: ContentPage, path: string, describe: (messages: Messages) => string) {
  return async (): Promise<Metadata> => {
    const locale = await getLocale();
    return pageSeo(locale, { path, title: inlineText(splitTitle(contentBlocks(page, locale)).title), description: withApp(describe(getMessages(locale))) });
  };
}

/** Markdown blocks as one plain string (an answer in the FAQ's structured data). */
export function blocksText(blocks: Block[]): string {
  return blocks
    .map((block) => {
      if (block.type === "list") return block.items.map(inlineText).join(" ");
      if (block.type === "table") return [block.head, ...block.rows].map((row) => row.map(inlineText).join(" ")).join(" ");
      return "text" in block ? inlineText(block.text) : "";
    })
    .filter(Boolean)
    .join(" ");
}

const ORGANIZATION = `${APP_URL}/#organization`;
const WEBSITE = `${APP_URL}/#website`;
const LOGO = `${APP_URL}/#logo`;

/** The graph CopyDog puts on every page — who publishes the site, the site,
 * and the app — with Orbie's own names, addresses and images. */
export function siteJsonLd(locale: Locale, messages: Messages) {
  const description = withApp(messages.meta.app);
  const home = `${APP_URL}${localePath(locale, "/")}`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": ORGANIZATION,
        name: APP_NAME,
        url: home,
        logo: { "@type": "ImageObject", "@id": LOGO, url: `${APP_URL}/icon-512.png`, contentUrl: `${APP_URL}/icon-512.png`, width: 512, height: 512, caption: `${APP_NAME} logo` },
        image: { "@id": LOGO },
        description,
        sameAs: [X_URL, TELEGRAM_BOT_URL],
      },
      { "@type": "WebSite", "@id": WEBSITE, name: APP_NAME, url: home, inLanguage: locale, publisher: { "@id": ORGANIZATION }, description: messages.meta.description },
      {
        "@type": "SoftwareApplication",
        "@id": `${APP_URL}/#app`,
        name: APP_NAME,
        url: home,
        applicationCategory: "FinanceApplication",
        operatingSystem: "Web",
        description,
        image: { "@id": LOGO },
        screenshot: { "@type": "ImageObject", "@id": `${APP_URL}/#app-screenshot`, url: `${APP_URL}/opengraph-image`, contentUrl: `${APP_URL}/opengraph-image`, width: 1200, height: 630 },
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        provider: { "@id": ORGANIZATION },
      },
    ],
  };
}

/** CopyDog's about page adds a WebPage that belongs to the site. */
export function webPageJsonLd({ locale, name, description, path }: { locale: Locale; name: string; description: string; path: string }) {
  return { "@context": "https://schema.org", "@type": "WebPage", name, description, url: `${APP_URL}${localePath(locale, path)}`, inLanguage: locale, isPartOf: { "@id": WEBSITE } };
}

/** CopyDog's help page lists every question and its answer as a FAQPage. */
export function faqJsonLd(questions: Array<{ question: string; answer: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: questions.map(({ question, answer }) => ({ "@type": "Question", name: question, acceptedAnswer: { "@type": "Answer", text: answer } })),
  };
}
