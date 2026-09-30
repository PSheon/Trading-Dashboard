import { CONTENT_PAGES } from "@/content/pages.generated";
import type { Locale } from "@/i18n/config";
import { parseMarkdown, type Block } from "@/lib/markdown";

export type ContentPage = keyof typeof CONTENT_PAGES;
type ContentLocale = keyof (typeof CONTENT_PAGES)[ContentPage];

/** The long pages exist in 繁體中文 and English; every other locale reads
 * the English text. */
export function contentLocale(locale: Locale): ContentLocale {
  return locale === "zh-TW" ? "zh-TW" : "en";
}

export function contentSource(page: ContentPage, locale: Locale): string {
  return CONTENT_PAGES[page][contentLocale(locale)];
}

export function contentBlocks(page: ContentPage, locale: Locale): Block[] {
  return parseMarkdown(contentSource(page, locale));
}

/** The page's `# title` and the rest, for pages that lay the title out
 * themselves. */
export function splitTitle(blocks: Block[]): { title: string; rest: Block[] } {
  const i = blocks.findIndex((b) => b.type === "heading" && b.level === 1);
  if (i < 0) return { title: "", rest: blocks };
  const heading = blocks[i] as Extract<Block, { type: "heading" }>;
  return { title: heading.text, rest: [...blocks.slice(0, i), ...blocks.slice(i + 1)] };
}
