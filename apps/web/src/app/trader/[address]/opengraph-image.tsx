import { headers } from "next/headers";

import { clientAddress, imageRetryAfter } from "@/lib/client-address";
import { ogSize } from "@/lib/og-card";
import { ADDRESS_RE, loadShareCard } from "@/lib/share-card-data";
import { renderShareCard } from "@/lib/share-card-image";
import { shareCardData } from "@/lib/share-card";

export const alt = "Trader PnL card";
export const size = ogSize;
export const contentType = "image/png";

/** The trader page's link preview: its all-time share card (16:9 layout at
 * 1200 × 630). An invalid address gets a blank card, not an error. */
export default async function TraderOpengraphImage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const raw = decodeURIComponent(address);
  const client = clientAddress(await headers());
  if (ADDRESS_RE.test(raw)) {
    const wait = imageRetryAfter(client);
    if (wait) return new Response("Too many requests", { status: 429, headers: { "Retry-After": String(wait), "Cache-Control": "no-store" } });
  }
  const data = ADDRESS_RE.test(raw) ? await loadShareCard(raw, "allTime", { client }) : shareCardData({ address: raw.slice(0, 42), period: "allTime" });
  return renderShareCard(data, "landscape", { size: ogSize });
}
