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
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/coin-icon/[coin]">) {
  const { coin } = await ctx.params;
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
