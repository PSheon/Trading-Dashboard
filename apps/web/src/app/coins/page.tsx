import { CoinIndexView } from "@/components/coins/coins-view";
import { seo } from "@/lib/seo";

export const generateMetadata = seo("/coins", (m) => ({ title: m.coins.indexTitle, description: m.meta.pages.coins }));

/** CopyDog's `/hyperliquid/coins`: every market's top traders. */
export default function CoinsPage() {
  return <CoinIndexView />;
}
