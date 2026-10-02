import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";

import { CoinBoardView } from "@/components/coins/coins-view";
import { getLocale, getMessages } from "@/i18n/server";
import { coinFromSlug, coinHref } from "@/lib/coin-slug";
import { clientAddress } from "@/lib/client-address";
import { coinIsUnknown } from "@/lib/coin-presence";
import { coinLabel } from "@/lib/format";
import { pageSeo } from "@/lib/seo";
import { loadCoinBoard } from "@/lib/share-card-data";

/** One api read per request, shared by the metadata and the page. */
const unknownMarket = cache(async (coin: string) => coinIsUnknown(await loadCoinBoard(coin, { client: clientAddress(await headers()) })) === true);

export async function generateMetadata({ params }: PageProps<"/coins/[coin]">): Promise<Metadata> {
  const coin = coinFromSlug((await params).coin);
  const locale = await getLocale();
  const messages = getMessages(locale);
  if (!coin || (await unknownMarket(coin))) return {}; // a 404 takes its title from not-found.tsx
  const label = coinLabel(coin);
  return pageSeo(locale, { path: coinHref(coin), title: messages.coins.title.replace("{coin}", label), description: messages.coins.body.replaceAll("{coin}", label) });
}

/** CopyDog's `/hyperliquid/coins/BTC` (`/coins/xyz-TSLA` for HIP-3). A slug
 * that can't be a coin, or a name that is not a Hyperliquid market (main dex
 * or HIP-3, as the api's catalog knows it), is a real 404, decided here
 * before the response starts. A real market none of the pool's traders has
 * traded is the page with its 「尚無市場資料」 empty state (200), as on CopyDog.
 * When the api can't say, the page renders and decides once its own read
 * answers. */
export default async function CoinPage({ params }: PageProps<"/coins/[coin]">) {
  const coin = coinFromSlug((await params).coin);
  if (!coin || (await unknownMarket(coin))) notFound();
  return <CoinBoardView coin={coin} />;
}
