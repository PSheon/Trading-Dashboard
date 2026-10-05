import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";

import { TraderView } from "@/components/trader/trader-view";
import { getLocale, getMessages } from "@/i18n/server";
import { clientAddress } from "@/lib/client-address";
import { truncateAddress } from "@/lib/format";
import { pageSeo } from "@/lib/seo";
import { prefetchTrader } from "@/lib/server-prefetch";
import { withApp } from "@/lib/seo-text";
import { loadTraderName } from "@/lib/share-card-data";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The path segment decoded; "" (never an address) when it is not valid
 * percent-encoding, which `decodeURIComponent` answers by throwing. */
function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

/** The profile and activity, read once per request (metadata and page),
 * within the 1.5 s prefetch budget, counted against the visitor. */
const traderRead = cache(async (address: string) => prefetchTrader(address, { client: clientAddress(await headers()) }));

export async function generateMetadata({ params }: PageProps<"/[locale]/trader/[address]">): Promise<Metadata> {
  const address = decodedSegment((await params).address);
  const locale = await getLocale();
  const messages = getMessages(locale);
  if (!ADDRESS.test(address)) return {}; // a 404 takes its title from not-found.tsx
  // CopyDog's tab: "<name or short address> · Hyperliquid"; its description
  // names the trader; the canonical URL is the lowercase address.
  const client = clientAddress(await headers());
  const [found, read] = await Promise.all([loadTraderName(address, { client }), traderRead(address)]);
  if (read.unknown) return {};
  const name = found ?? truncateAddress(address);
  const path = `/trader/${address.toLowerCase()}`;
  // The trader's own card (app/trader/[address]/opengraph-image.tsx, outside
  // the locale tree: one image for every language, at the URL already shared).
  const images = [{ url: `${path}/opengraph-image`, width: 1200, height: 630, alt: "Trader PnL card", type: "image/png" }];
  return pageSeo(locale, { path, title: `${name} · Hyperliquid`, description: withApp(messages.meta.pages.trader.replaceAll("{name}", name)), images });
}

/** Anything that can't be an address (the search box sends whatever was
 * typed here, as CopyDog's does) is the 404. The profile and activity are
 * read here, before anything is sent (no Suspense, no loading.tsx: a
 * streamed page can no longer answer 404): an address with nothing on
 * Hyperliquid is a real 404, and a known one renders its profile in the
 * first HTML. When the api is slow or down the page renders without them
 * and the browser reads and decides, as before. */
export default async function TraderPage({ params }: PageProps<"/[locale]/trader/[address]">) {
  const address = decodedSegment((await params).address);
  if (!ADDRESS.test(address)) notFound();
  const { profile, activity, unknown } = await traderRead(address);
  if (unknown) notFound();
  return <TraderView address={address} initial={{ profile, activity }} />;
}
