// Server-only (reads the locale cookie through i18n/server).
import type { Metadata } from "next";

import { OG_LOCALES, type Locale } from "@/i18n/config";
import { getLocale, getMessages } from "@/i18n/server";
import type { Messages } from "@/i18n/messages";
import { APP_NAME, APP_URL } from "@/lib/config";
import { contentBlocks, splitTitle, type ContentPage } from "@/lib/content";
import { inlineText, type Block } from "@/lib/markdown";
import { withApp } from "@/lib/seo-text";

/** CopyDog's robots meta for a public page. */
const INDEXED = { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 } as const;
/** Personal pages (favorites, portfolio, settings): CopyDog's `noindex, follow`. */
const PRIVATE = { index: false, follow: true } as const;

export interface PageSeo {
  /** Without the site name; the root layout's template adds it. */
  title: string;
  description: string;
  /** The page's own path: its canonical URL and `og:url`. */
  path: string;
  /** false: a personal page, kept out of search results. */
  index?: boolean;
  /** The title is already complete (the home page). */
  absolute?: boolean;
}

/**
 * One page's head, in the structure CopyDog serves: its own title and
 * description, a canonical URL, robots, and the same pair repeated for
 * link previews. Open Graph and Twitter are written out in full because a
 * page's `openGraph` replaces the layout's rather than merging with it.
 */
export function pageSeo(locale: Locale, { title, description, path, index = true, absolute = false }: PageSeo): Metadata {
  const full = absolute ? title : `${title} | ${APP_NAME}`;
  return {
    title: absolute ? { absolute: title } : title,
    description,
    alternates: { canonical: path },
    robots: index ? INDEXED : PRIVATE,
    openGraph: { type: "website", siteName: APP_NAME, url: path, title: full, description, locale: OG_LOCALES[locale] },
    twitter: { card: "summary_large_image", title: full, description },
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
export function siteJsonLd(messages: Messages) {
  const description = withApp(messages.meta.app);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": ORGANIZATION,
        name: APP_NAME,
        url: `${APP_URL}/`,
        logo: { "@type": "ImageObject", "@id": LOGO, url: `${APP_URL}/icon-512.png`, contentUrl: `${APP_URL}/icon-512.png`, width: 512, height: 512, caption: `${APP_NAME} logo` },
        image: { "@id": LOGO },
        description,
        sameAs: ["https://t.me/orbie_fun_bot"],
      },
      { "@type": "WebSite", "@id": WEBSITE, name: APP_NAME, url: `${APP_URL}/`, publisher: { "@id": ORGANIZATION }, description: messages.meta.description },
      {
        "@type": "SoftwareApplication",
        "@id": `${APP_URL}/#app`,
        name: APP_NAME,
        url: `${APP_URL}/`,
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
export function webPageJsonLd({ name, description, path }: { name: string; description: string; path: string }) {
  return { "@context": "https://schema.org", "@type": "WebPage", name, description, url: `${APP_URL}${path}`, isPartOf: { "@id": WEBSITE } };
}

/** CopyDog's help page lists every question and its answer as a FAQPage. */
export function faqJsonLd(questions: Array<{ question: string; answer: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: questions.map(({ question, answer }) => ({ "@type": "Question", name: question, acceptedAnswer: { "@type": "Answer", text: answer } })),
  };
}
