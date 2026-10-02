import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";

import { CoinBoardView } from "@/components/coins/coins-view";
import { getLocale, getMessages } from "@/i18n/server";
import { coinFromSlug } from "@/lib/coin-slug";
import { clientAddress } from "@/lib/client-address";
import { coinIsUnknown } from "@/lib/coin-presence";
import { coinLabel } from "@/lib/format";
import { loadCoinBoard } from "@/lib/share-card-data";

/** One api read per request, shared by the metadata and the page. */
const unknownMarket = cache(async (coin: string) => coinIsUnknown(await loadCoinBoard(coin, { client: clientAddress(await headers()) })) === true);

export async function generateMetadata({ params }: PageProps<"/coins/[coin]">): Promise<Metadata> {
  const coin = coinFromSlug((await params).coin);
  const m = getMessages(await getLocale()).coins;
  // The 404 keeps the site's own title.
  if (!coin || (await unknownMarket(coin))) return {};
  const label = coinLabel(coin);
  return { title: m.title.replace("{coin}", label), description: m.body.replaceAll("{coin}", label) };
}

/** CopyDog's `/hyperliquid/coins/BTC` (`/coins/xyz-TSLA` for HIP-3). A slug
 * that can't be a coin, or a coin none of the pool's traders has traded, is
 * a real 404 (decided here, before the response starts); when the api can't
 * say, the page renders and decides once its own read answers. */
export default async function CoinPage({ params }: PageProps<"/coins/[coin]">) {
  const coin = coinFromSlug((await params).coin);
  if (!coin || (await unknownMarket(coin))) notFound();
  return <CoinBoardView coin={coin} />;
}
