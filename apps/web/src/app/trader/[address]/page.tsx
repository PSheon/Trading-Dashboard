import type { Metadata } from "next";

import { TraderView } from "@/components/trader/trader-view";
import { getLocale, getMessages } from "@/i18n/server";
import { truncateAddress } from "@/lib/format";

export async function generateMetadata({ params }: PageProps<"/trader/[address]">): Promise<Metadata> {
  const { address } = await params;
  const messages = getMessages(await getLocale());
  return { title: `${truncateAddress(address)} · ${messages.trader.title}` };
}

export default async function TraderPage({ params }: PageProps<"/trader/[address]">) {
  const { address } = await params;
  return <TraderView address={decodeURIComponent(address)} />;
}
