import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CoinBoardView } from "@/components/coins/coins-view";
import { getLocale, getMessages } from "@/i18n/server";
import { coinFromSlug } from "@/lib/coin-slug";
import { coinLabel } from "@/lib/format";

export async function generateMetadata({ params }: PageProps<"/coins/[coin]">): Promise<Metadata> {
  const coin = coinFromSlug((await params).coin);
  const m = getMessages(await getLocale()).coins;
  if (!coin) return {};
  const label = coinLabel(coin);
  return { title: m.title.replace("{coin}", label), description: m.body.replaceAll("{coin}", label) };
}

/** CopyDog's `/hyperliquid/coins/BTC` (`/coins/xyz-TSLA` for HIP-3). */
export default async function CoinPage({ params }: PageProps<"/coins/[coin]">) {
  const coin = coinFromSlug((await params).coin);
  if (!coin) notFound();
  return <CoinBoardView coin={coin} />;
}
