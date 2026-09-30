import { CoinIndexView } from "@/components/coins/coins-view";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => m.coins.indexTitle);

/** CopyDog's `/hyperliquid/coins`: every market's top traders. */
export default function CoinsPage() {
  return <CoinIndexView />;
}
