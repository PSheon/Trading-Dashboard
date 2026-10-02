import type { NextRequest } from "next/server";

import { clientAddress, imageRetryAfter } from "@/lib/client-address";
import { ADDRESS_RE, loadShareCard, SHARE_REVALIDATE_S } from "@/lib/share-card-data";
import { renderShareCard } from "@/lib/share-card-image";
import { isShareFormat, isSharePeriod } from "@/lib/share-card";

/**
 * GET /trader/<address>/share-image?period=allTime|month|week|day&format=landscape|portrait
 * → the trader's share card as a PNG (CopyDog's 分享交易員主頁 card), for the
 * share dialog's preview, copy and download. Rendered here with next/og
 * from apps/api data read server-side; no outside service.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/trader/[address]/share-image">) {
  const { address } = await ctx.params;
  const period = request.nextUrl.searchParams.get("period") ?? "allTime";
  const format = request.nextUrl.searchParams.get("format") ?? "landscape";
  if (!ADDRESS_RE.test(address) || !isSharePeriod(period) || !isShareFormat(format)) {
    return new Response("Bad request", { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  // The card is built from api reads made here: they count against the
  // caller, and one caller can't ask for cards without end.
  const client = clientAddress(request.headers);
  const wait = imageRetryAfter(client);
  if (wait) return new Response("Too many requests", { status: 429, headers: { "Retry-After": String(wait), "Cache-Control": "no-store" } });
  const data = await loadShareCard(address, period, { client });
  return renderShareCard(data, format, {
    headers: { "Cache-Control": `public, max-age=${SHARE_REVALIDATE_S}, stale-while-revalidate=${SHARE_REVALIDATE_S}` },
  });
}
