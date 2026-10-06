import { coinFromSlug } from "@/lib/coin-slug";
import { labEnabled } from "@/lib/dev-lab";

/**
 * Every page under `app/[locale]`, as the path after the locale, in Next's
 * own segment syntax. `test/page-routes.test.ts` holds this list to the
 * files, so a page added without its line here fails the test.
 *
 * Why the proxy needs it: in this Next (16.3), `notFound()` thrown while a
 * page renders reaches React's server renderer, which has no error
 * boundaries, so the response is a 404 whose HTML is an empty
 * `<html id="__next_error__">` and the 404 page only appears once the
 * browser has hydrated. A 404 the proxy can decide on its own (no page
 * matches, an address or coin slug that can't be one, the lab when it is
 * off) is answered with the status from the proxy instead, and the page
 * renders the 404 itself (`renderNotFound`), in the first HTML.
 */
export const PAGE_ROUTES = [
  "/",
  "/about",
  "/admin",
  "/admin/copy",
  "/admin/copy/orders",
  "/admin/copy/risk",
  "/admin/copy/testnet",
  "/admin/settings",
  "/admin/traders",
  "/admin/traders/jobs",
  "/admin/traders/lists",
  "/admin/users",
  "/admin/users/audit",
  "/coins",
  "/coins/[coin]",
  "/delete-account",
  "/dev/[[...preview]]",
  "/dev/buttons",
  "/dev/copy",
  "/dev/crash",
  "/dev/explore/all",
  "/dev/skeletons",
  "/dev/skeletons/[item]",
  "/explore",
  "/favorites",
  "/help",
  "/insights",
  "/portfolio",
  "/privacy",
  "/r/[code]",
  "/settings",
  "/terms",
  "/trader/[address]",
] as const;

export type PageRoute = (typeof PAGE_ROUTES)[number];

/** The request header the proxy sets on a request it answers 404 (read by
 * the root layout's metadata and by `renderNotFound`). The proxy always
 * overwrites or removes it, so a visitor can't send it. */
export const NOT_FOUND_HEADER = "x-orbie-not-found";

function routePattern(route: string): RegExp {
  if (route === "/") return /^\/?$/;
  const parts = route.slice(1).split("/").map((segment) => {
    if (/^\[\[\.\.\..+\]\]$/.test(segment)) return "(?:/[^/]+)*";
    if (/^\[\.\.\..+\]$/.test(segment)) return "(?:/[^/]+)+";
    if (/^\[.+\]$/.test(segment)) return "/[^/]+";
    return `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
  });
  return new RegExp(`^${parts.join("")}/?$`);
}

const PATTERNS = PAGE_ROUTES.map((route) => [route, routePattern(route)] as const);

/** The page a path (after the locale) is served by; null when only the
 * catch-all (`[...missing]`) would take it. Optional catch-alls match
 * their parent too (`/dev` is `/dev/[[...preview]]`); static routes win
 * over dynamic ones, as in Next. */
export function matchPageRoute(path: string): PageRoute | null {
  const matches = PATTERNS.filter(([, pattern]) => pattern.test(path)).map(([route]) => route);
  if (matches.length === 0) return null;
  return matches.find((route) => !route.includes("[")) ?? matches[0]!;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

/** True when the proxy alone knows this page URL (`/<locale>/…`) is a 404:
 * no page matches it, the trader segment can't be an address, the coin
 * slug can't be a coin, or it is the lab while the lab is off. A 404 that
 * needs the api's answer (an address Hyperliquid has nothing for, a name
 * that is no market) is left to the page. */
export function isStaticNotFound(pathname: string): boolean {
  const rest = pathname.replace(/^\/[^/]+/, "") || "/";
  const route = matchPageRoute(rest);
  if (!route) return true;
  const segments = rest.split("/").filter(Boolean);
  if (route === "/trader/[address]") return !ADDRESS.test(decoded(segments[1] ?? ""));
  if (route === "/coins/[coin]") return coinFromSlug(segments[1] ?? "") === null;
  if (route.startsWith("/dev")) return !labEnabled();
  return false;
}
