import type { NextRequest } from "next/server";

import { clientAddress, imageRetryAfter } from "@/lib/client-address";
import { ADDRESS_RE, loadShareCard, SHARE_REVALIDATE_S } from "@/lib/share-card-data";
import { renderShareCard } from "@/lib/share-card-image";
import { isShareFormat, isSharePeriod } from "@/lib/share-card";
import { loadLeaderPosition, loadLeaderTrade, testModeSample } from "@/lib/trade-card-data";
import { renderTradeCard } from "@/lib/trade-card-image";
import { parseCardRequest } from "@/lib/trade-card-params";

/**
 * GET /trader/<address>/share-image?period=allTime|month|week|day&format=landscape|portrait
 * → the trader's share card as a PNG (CopyDog's 分享交易員主頁 card), for the
 * share dialog's preview, copy and download. Rendered here with next/og
 * from apps/api data read server-side; no outside service.
 *
 * `kind=trade&id=<round-trip id>` or `kind=position&coin=<market>` with
 * `style=card|poster`: one of the trader's closed trades or open positions
 * (CopyDog's Share Trade / Share Position). The figures are read here,
 * never taken from the URL; an unknown trade or position is a 404.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/trader/[address]/share-image">) {
  const { address } = await ctx.params;
  const kind = request.nextUrl.searchParams.get("kind");
  if (kind === "trade" || kind === "position") return tradeCard(request, address);
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

async function tradeCard(request: NextRequest, address: string) {
  const req = parseCardRequest(request.nextUrl.searchParams, false);
  if (!ADDRESS_RE.test(address) || !req) return new Response("Bad request", { status: 400, headers: { "Cache-Control": "no-store" } });
  const client = clientAddress(request.headers);
  const wait = imageRetryAfter(client);
  if (wait) return new Response("Too many requests", { status: 429, headers: { "Retry-After": String(wait), "Cache-Control": "no-store" } });
  const data = req.kind === "trade" ? await loadLeaderTrade(address, req.id, { client }) : await loadLeaderPosition(address, req.coin, { client });
  const card = data ?? testModeSample(req.kind, false);
  if (!card) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  // A closed trade does not change; an open position is a live figure.
  const cache = req.kind === "trade" ? `public, max-age=${SHARE_REVALIDATE_S}` : "public, max-age=30";
  return renderTradeCard(card, req.style, req.format, { headers: { "Cache-Control": cache } });
}
