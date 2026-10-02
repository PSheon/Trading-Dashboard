import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { TraderView } from "@/components/trader/trader-view";
import { clientAddress } from "@/lib/client-address";
import { truncateAddress } from "@/lib/format";
import { loadTraderName } from "@/lib/share-card-data";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function generateMetadata({ params }: PageProps<"/trader/[address]">): Promise<Metadata> {
  const address = decodeURIComponent((await params).address);
  // The 404 keeps the site's own title.
  if (!ADDRESS.test(address)) return {};
  // CopyDog's tab: "<name or short address> · Hyperliquid".
  const client = clientAddress(await headers());
  return { title: `${(await loadTraderName(address, { client })) ?? truncateAddress(address)} · Hyperliquid` };
}

/** Anything that can't be an address (the search box sends whatever was
 * typed here, as CopyDog's does) is the 404. An address with nothing on
 * Hyperliquid becomes the 404 once the page has asked (TraderView). */
export default async function TraderPage({ params }: PageProps<"/trader/[address]">) {
  const address = decodeURIComponent((await params).address);
  if (!ADDRESS.test(address)) notFound();
  return <TraderView address={address} />;
}
