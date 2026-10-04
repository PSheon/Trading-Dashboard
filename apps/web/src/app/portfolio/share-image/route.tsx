import type { NextRequest } from "next/server";

import { clientAddress, imageRetryAfter } from "@/lib/client-address";
import { loadCopyPosition, loadCopyTrade, testModeSample } from "@/lib/trade-card-data";
import { renderTradeCard } from "@/lib/trade-card-image";
import { parseCardRequest } from "@/lib/trade-card-params";

const noStore = { "Cache-Control": "private, no-store" };

/**
 * GET /portfolio/share-image?kind=trade&id=…|kind=position&strategyId=…&coin=…&style=card|poster&format=landscape|portrait
 * → one of the caller's own copy trades or positions as a PNG card. The
 * page fetches it with the caller's Authorization header, which is passed
 * to apps/api for the read and nowhere else; the figures are the api's,
 * never the URL's. Never cached (a person's own data).
 */
export async function GET(request: NextRequest) {
  const req = parseCardRequest(request.nextUrl.searchParams, true);
  if (!req) return new Response("Bad request", { status: 400, headers: noStore });
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer [\w.~+/=-]{16,4096}$/.test(authorization) && !testModeSample(req.kind, true)) return new Response("Sign in required", { status: 401, headers: noStore });
  const client = clientAddress(request.headers);
  const wait = imageRetryAfter(client);
  if (wait) return new Response("Too many requests", { status: 429, headers: { "Retry-After": String(wait), ...noStore } });
  const data = req.kind === "trade"
    ? await loadCopyTrade(req.id, { client, authorization })
    : await loadCopyPosition(req.strategyId!, req.coin, { client, authorization });
  const card = data ?? testModeSample(req.kind, true);
  if (!card) return new Response("Not found", { status: 404, headers: noStore });
  return renderTradeCard(card, req.style, req.format, { headers: noStore });
}
