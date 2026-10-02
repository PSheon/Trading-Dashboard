import type { MetadataRoute } from "next";

import { coinFromSlug, coinSlug } from "@/lib/coin-slug";
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
 * listed trader. Markets and traders come from the api; when it can't be
 * reached the fixed pages are still served. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { coins, traders } = await loadSitemapData();
  const today = new Date();
  const url = (path: string) => `${APP_URL}${path === "/" ? "/" : path}`;
  return [
    ...DATA_PAGES.map((path) => ({ url: url(path), lastModified: today })),
    ...WRITTEN_PAGES.map((path) => ({ url: url(path) })),
    // Only slugs the coin page accepts.
    ...coins.filter((coin) => coinFromSlug(coinSlug(coin)) === coin).map((coin) => ({ url: url(`/coins/${coinSlug(coin)}`), lastModified: today })),
    ...traders.map((address) => ({ url: url(`/trader/${address}`), lastModified: today })),
  ];
}
