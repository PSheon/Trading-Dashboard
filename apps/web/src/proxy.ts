import { NextResponse, type NextRequest } from "next/server";

import { contentSecurityPolicy, newNonce, privyAuthOrigins } from "@/lib/csp";

/** Read at run time (server-only), so one build serves every deployment. */
const privyOrigins = privyAuthOrigins(process.env.NEXT_PRIVY_AUTH_ORIGINS);

/**
 * Sets the Content-Security-Policy (see `lib/csp.ts`) with a fresh nonce on
 * every page. Next.js takes the nonce from the request's CSP header and
 * adds it to its scripts; pages are dynamically rendered already (the root
 * layout reads the locale cookie), which nonces require.
 */
export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const csp = contentSecurityPolicy({ nonce, dev: process.env.NODE_ENV === "development", privyOrigins });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
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
