import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { TraderView } from "@/components/trader/trader-view";
import { getLocale, getMessages } from "@/i18n/server";
import { clientAddress } from "@/lib/client-address";
import { truncateAddress } from "@/lib/format";
import { pageSeo } from "@/lib/seo";
import { withApp } from "@/lib/seo-text";
import { loadTraderName } from "@/lib/share-card-data";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function generateMetadata({ params }: PageProps<"/trader/[address]">): Promise<Metadata> {
  const address = decodeURIComponent((await params).address);
  const locale = await getLocale();
  const messages = getMessages(locale);
  if (!ADDRESS.test(address)) return {}; // a 404 takes its title from not-found.tsx
  // CopyDog's tab: "<name or short address> · Hyperliquid"; its description
  // names the trader; the canonical URL is the lowercase address.
  const client = clientAddress(await headers());
  const name = (await loadTraderName(address, { client })) ?? truncateAddress(address);
  return pageSeo(locale, { path: `/trader/${address.toLowerCase()}`, title: `${name} · Hyperliquid`, description: withApp(messages.meta.pages.trader.replaceAll("{name}", name)) });
}

/** Anything that can't be an address (the search box sends whatever was
 * typed here, as CopyDog's does) is the 404. An address with nothing on
 * Hyperliquid becomes the 404 once the page has asked (TraderView). */
export default async function TraderPage({ params }: PageProps<"/trader/[address]">) {
  const address = decodeURIComponent((await params).address);
  if (!ADDRESS.test(address)) notFound();
  return <TraderView address={address} />;
}
