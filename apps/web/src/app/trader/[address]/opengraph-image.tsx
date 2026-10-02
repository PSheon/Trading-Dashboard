import { headers } from "next/headers";

import { clientAddress, imageRetryAfter } from "@/lib/client-address";
import { ogSize } from "@/lib/og-card";
import { ADDRESS_RE, loadShareCard } from "@/lib/share-card-data";
import { renderShareCard } from "@/lib/share-card-image";

export const alt = "Trader PnL card";
export const size = ogSize;
export const contentType = "image/png";

/** The trader page's link preview: its all-time share card (16:9 layout at
 * 1200 × 630). Anything that can't be an address is a 404, like its page. */
export default async function TraderOpengraphImage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!ADDRESS_RE.test(address)) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const client = clientAddress(await headers());
  const wait = imageRetryAfter(client);
  if (wait) return new Response("Too many requests", { status: 429, headers: { "Retry-After": String(wait), "Cache-Control": "no-store" } });
  return renderShareCard(await loadShareCard(address, "allTime", { client }), "landscape", { size: ogSize });
}
