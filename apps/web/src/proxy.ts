import { NextResponse, type NextRequest } from "next/server";

import { SESSION_REQUIRED_HEADER } from "@/lib/api";
import {
  LOGIN_PATH,
  SESSION_COOKIE,
  isValidSession,
  safeNextPath,
} from "@/lib/session";

/**
 * Every route — pages and the /api/hl/* forwarder — needs a valid session
 * cookie, except /login itself (its server action posts to /login too) and
 * the static assets excluded by `config.matcher` below.
 *
 * This is the first line of defense only: the /api/hl route handler and the
 * server actions re-check the session themselves.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const authed = isValidSession(request.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === LOGIN_PATH) {
    // Already logged in: skip the form. Server-action POSTs always go
    // through so the login action can run.
    if (authed && request.method === "GET") {
      const next = safeNextPath(request.nextUrl.searchParams.get("next"));
      return NextResponse.redirect(new URL(next, request.url));
    }
    return NextResponse.next();
  }

  if (authed) return NextResponse.next();

  if (pathname === "/api/hl" || pathname.startsWith("/api/hl/")) {
    return NextResponse.json(
      { statusCode: 401, message: "Login required" },
      { status: 401, headers: { [SESSION_REQUIRED_HEADER]: "1" } },
    );
  }

  const loginUrl = new URL(LOGIN_PATH, request.url);
  const next = safeNextPath(`${pathname}${search}`);
  if (next !== "/") loginUrl.searchParams.set("next", next);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Everything except Next's build output, image optimizer and the
    // favicon/robots/sitemap metadata files.
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
