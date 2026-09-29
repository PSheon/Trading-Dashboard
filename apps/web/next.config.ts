import type { NextConfig } from "next";

const fixtures = process.env.NEXT_PUBLIC_API_FIXTURES === "1";

const nextConfig: NextConfig = {
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

export default nextConfig;
