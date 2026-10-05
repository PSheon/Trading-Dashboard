import { NextResponse, type NextRequest } from "next/server";

import { DEFAULT_LOCALE, LOCALES, LOCALE_COOKIE, PATH_HEADER, isLocale, localePath, negotiateLocale, type Locale } from "@/i18n/config";
import { contentSecurityPolicy, newNonce, privyAuthOrigins, type Framing } from "@/lib/csp";

/** Read at run time (server-only), so one build serves every deployment. */
const privyOrigins = privyAuthOrigins(process.env.NEXT_PRIVY_AUTH_ORIGINS);

/** Never moved under a locale: the api forwarders, Next's own files, the
 * metadata routes (robots, sitemap, manifest, icons, the Open Graph and
 * share images, whose URLs are already posted around) and static files. */
const UNPREFIXED = [
  /^\/(api|_next|_vercel)(\/|$)/,
  /^\/(robots\.txt|sitemap\.xml|manifest\.webmanifest|favicon\.ico|opengraph-image|twitter-image|apple-icon|icon)(\/|$|-|\.)/,
  /\/(opengraph-image|twitter-image|share-image)(-[\w-]+)?$/,
  /\.(png|jpe?g|gif|svg|ico|webp|avif|txt|xml|webmanifest|js|css|map|json|woff2?|ttf|otf|mp4|webm)$/i,
];

export function isUnprefixedRoute(pathname: string): boolean {
  return UNPREFIXED.some((pattern) => pattern.test(pathname));
}

/** The language for a URL without one: the visitor's saved choice (the
 * cookie), then their browser's Accept-Language, then zh-TW. */
export function preferredLocale(cookie: string | undefined, acceptLanguage: string | null): Locale {
  return isLocale(cookie) ? cookie : negotiateLocale(acceptLanguage) ?? DEFAULT_LOCALE;
}

/**
 * Locale routing, as DonutMe's next-intl proxy does it (`localePrefix:
 * "always"`): a page URL without a locale is redirected (307, query kept)
 * to the same path under the visitor's language; a locale written in the
 * wrong case (`/zh-tw/…`) to its proper spelling.
 *
 * Then the Content-Security-Policy (see `lib/csp.ts`) with a fresh nonce on
 * every page. Next.js takes the nonce from the request's CSP header and
 * adds it to its scripts; pages are dynamically rendered already, which
 * nonces require.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!isUnprefixedRoute(pathname)) {
    const first = pathname.split("/")[1] ?? "";
    if (!isLocale(first)) {
      const url = request.nextUrl.clone();
      const misspelt = LOCALES.find((locale) => locale.toLowerCase() === first.toLowerCase());
      url.pathname = misspelt
        ? localePath(misspelt, pathname.slice(first.length + 1) || "/")
        : localePath(preferredLocale(request.cookies.get(LOCALE_COOKIE)?.value, request.headers.get("accept-language")), pathname);
      return NextResponse.redirect(url, 307);
    }
  }

  const nonce = newNonce();
  const csp = contentSecurityPolicy({ nonce, dev: process.env.NODE_ENV === "development", privyOrigins, framing: galleryFraming(pathname) });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  headers.set(PATH_HEADER, pathname);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

/** The skeleton gallery and its frames (see `Framing`). */
export function galleryFraming(pathname: string): Framing | undefined {
  const match = /^\/[^/]+\/dev\/skeletons(\/[^/]+)?\/?$/.exec(pathname);
  if (!match) return undefined;
  return match[1] ? "framed" : "gallery";
}

export const config = {
  matcher: [
    {
      // Pages only: not the API forwarder, static assets or prefetches.
      source: "/((?!api/|_next/static|_next/image|favicon.ico|icon.svg|apple-icon).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
