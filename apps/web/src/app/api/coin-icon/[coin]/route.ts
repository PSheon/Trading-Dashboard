import { clientAddress, iconRetryAfter } from "@/lib/client-address";
import { coinIcons } from "@/lib/coin-icon-source";

const DAY_S = 24 * 60 * 60;

/**
 * GET /api/coin-icon/<coin> → the market's icon (Hyperliquid's own SVG),
 * served from this origin and cached, instead of the browser hot-linking
 * app.hyperliquid.xyz: that host answers 200 text/html for a market without
 * an icon, which the browser blocks (ORB) and logs. No icon is a 404, and
 * the page draws its own glyph.
 *
 * The SVG is someone else's file on our origin: it is only ever used as an
 * <img> (where scripts don't run), and opened directly it is sandboxed
 * (the Content-Security-Policy for this path in next.config.ts).
 *
 * Anonymous, so it is limited per client (`ICONS_PER_MINUTE`, 429 with
 * Retry-After), and only a market apps/api's catalog lists is fetched
 * upstream; any other name is a 404 (audit C).
 */
export async function GET(request: Request, ctx: RouteContext<"/api/coin-icon/[coin]">) {
  const { coin } = await ctx.params;
  const wait = iconRetryAfter(clientAddress(request.headers));
  if (wait) return new Response("Too many requests", { status: 429, headers: { "Retry-After": String(wait), "Cache-Control": "no-store" } });
  // The test server makes no outside requests.
  const icon = process.env.NEXT_TEST_MODE === "1" ? null : await coinIcons.get(coin);
  if (!icon) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=3600" } });
  return new Response(icon.svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": `public, max-age=${DAY_S}, stale-while-revalidate=${7 * DAY_S}`,
    },
  });
}
