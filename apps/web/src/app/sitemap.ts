import type { MetadataRoute } from "next";

import { coinFromSlug, coinSlug } from "@/lib/coin-slug";
import { LOCALES, localePath } from "@/i18n/config";
import { APP_URL } from "@/lib/config";
import { loadSitemapData } from "@/lib/share-card-data";

/** Rebuilt at most every hour: the boards behind it move slowly. */
export const revalidate = 3600;

/** Pages whose content is data and changes daily (lastmod: today), then the
 * written pages (no lastmod: they change when the text does). The personal
 * pages, /admin and /dev are not listed (robots.ts disallows them). */
const DATA_PAGES = ["/", "/explore", "/coins", "/insights"];
const WRITTEN_PAGES = ["/about", "/help", "/privacy", "/terms", "/delete-account"];

/** CopyDog's sitemap.xml: the fixed pages, one URL per market and one per
 * listed trader, each in all eleven languages (`/<locale>/…`), every entry
 * naming its other languages and the unprefixed x-default as alternates.
 * Markets and traders come from the api; when it can't be reached the
 * fixed pages are still served. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { coins, traders } = await loadSitemapData();
  const today = new Date();
  const url = (path: string) => `${APP_URL}${path}`;
  const languages = (path: string) => ({ ...Object.fromEntries(LOCALES.map((locale) => [locale, url(localePath(locale, path))])), "x-default": url(path) });
  const entries = (path: string, lastModified?: Date) => {
    const alternates = { languages: languages(path) };
    return LOCALES.map((locale) => ({ url: url(localePath(locale, path)), ...(lastModified ? { lastModified } : {}), alternates }));
  };
  return [
    ...DATA_PAGES.flatMap((path) => entries(path, today)),
    ...WRITTEN_PAGES.flatMap((path) => entries(path)),
    // Only slugs the coin page accepts.
    ...coins.filter((coin) => coinFromSlug(coinSlug(coin)) === coin).flatMap((coin) => entries(`/coins/${coinSlug(coin)}`, today)),
    ...traders.flatMap((address) => entries(`/trader/${address}`, today)),
  ];
}
