import { timingSafeEqual } from "node:crypto";

import { type NextRequest, NextResponse } from "next/server";

// HTTP Basic auth over every page and server action when APP_PASSWORD is set.
// Any username; only the password is checked. The health check stays open for
// the platform's probe.
export function proxy(request: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const given = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
    const expected = Buffer.from(password);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return NextResponse.next();
  }
  return new NextResponse("password required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="smart wallets"' },
  });
}

export const config = {
  matcher: ["/((?!api/health|_next/static|_next/image|favicon.ico).*)"],
};
