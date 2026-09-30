import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants";

// Local development keeps one .env at the repo root. apps/web takes only its
// NEXT_ block from it, so the api's secrets (AUTH_SERVICE_TOKEN,
// PRIVY_APP_SECRET, …) never enter this process. Values already set (the
// shell, apps/web/.env.local, Vercel) win. On Vercel there is no root .env.
const rootEnv = resolve(import.meta.dirname, "../../.env");
if (process.env.NEXT_TEST_MODE !== "1" && existsSync(rootEnv)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(rootEnv, "utf8")))) {
    if (key.startsWith("NEXT_") && process.env[key] === undefined) process.env[key] = value;
  }
}

const fixtures = process.env.NEXT_PUBLIC_API_FIXTURES === "1";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_TEST_MODE === "1" ? ".next-e2e" : ".next",
  poweredByHeader: false,
  headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=15552000" }] : []),
    ] }];
  },
  webpack(config) {
    if (!fixtures) config.resolve.alias["@/fixtures/handler"] = resolve(import.meta.dirname, "src/fixtures/disabled.ts");
    return config;
  },
  // Without fixture mode, the fixture handler (and the sample JSON it
  // imports) is replaced by a stub, so it never reaches a bundle.
  turbopack: fixtures
    ? undefined
    : { resolveAlias: { "@/fixtures/handler": "./src/fixtures/disabled.ts" } },
  // The dev badge sits on top of the icon rail's bottom items.
  devIndicators: false,
  // Stage 2 moved every page; old links (bookmarks, Telegram messages that
  // point at /leaders/<address>) land on their new homes.
  redirects() {
    return [
      { source: "/feed", destination: "/insights", permanent: false },
      { source: "/heatmap", destination: "/insights", permanent: false },
      { source: "/leaders", destination: "/explore", permanent: false },
      { source: "/leaders/:address", destination: "/trader/:address", permanent: false },
      { source: "/leaders/:chain/:address", destination: "/trader/:address", permanent: false },
      { source: "/alerts", destination: "/settings", permanent: false },
      { source: "/import", destination: "/admin/lists", permanent: false },
      { source: "/lists", destination: "/admin/lists", permanent: false },
      { source: "/status", destination: "/admin/system", permanent: false },
      { source: "/login", destination: "/", permanent: false },
    ];
  },
};

/** Fixture mode answers every API call from sample data in the browser (and
 * signs anyone in): development and tests only, never a production build
 * or server. */
export function assertNoFixturesInProduction(phase: string, env: NodeJS.ProcessEnv = process.env): void {
  const production = phase === PHASE_PRODUCTION_BUILD || phase === PHASE_PRODUCTION_SERVER || env.NODE_ENV === "production";
  if (env.NEXT_PUBLIC_API_FIXTURES === "1" && production) {
    throw new Error("NEXT_PUBLIC_API_FIXTURES=1 is for development and tests only; unset it for production builds.");
  }
}

export default function config(phase: string): NextConfig {
  assertNoFixturesInProduction(phase);
  return nextConfig;
}
