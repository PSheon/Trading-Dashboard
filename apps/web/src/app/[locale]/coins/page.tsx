import { headers } from "next/headers";
import { Suspense } from "react";

import { CoinIndexSkeleton, CoinIndexView } from "@/components/coins/coins-view";
import { clientAddress } from "@/lib/client-address";
import type { CoinIndexResponse } from "@/lib/contracts";
import { seo } from "@/lib/seo";
import { prefetchPublic } from "@/lib/server-prefetch";

export const generateMetadata = seo("/coins", (m) => ({ title: m.coins.indexTitle, description: m.meta.pages.coins }));

/** CopyDog's `/hyperliquid/coins`: every market's top traders. The index is
 * read on the server (a pool snapshot read on the api), so the first HTML
 * has the rows; the heading streams at once with skeleton rows, and a slow
 * or absent api leaves the browser to fetch it, as before. */
export default function CoinsPage() {
  return (
    <Suspense fallback={<CoinIndexSkeleton />}>
      <PrefetchedCoins />
    </Suspense>
  );
}

async function PrefetchedCoins() {
  const client = clientAddress(await headers());
  const coins = await prefetchPublic<CoinIndexResponse>("/discover/coins", { client });
  return <CoinIndexView initial={coins} />;
}
