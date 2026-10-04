import type { MetadataRoute } from "next";

import { APP_URL } from "@/lib/config";

/** Paths no crawler should fetch: the api forwarder, the back office, the
 * design lab, and the personal pages (which also carry `noindex`), as
 * CopyDog's robots.txt does for its own. Under /api/ everything stays
 * disallowed (the signed-in reads `/api/hl/me`, `/copy`, `/admin`, every
 * write) except the public reads below. */
export const DISALLOWED = ["/api/", "/api/hl/me", "/api/hl/copy", "/api/hl/admin", "/api/hl/actions/stream", "/admin", "/dev", "/settings", "/portfolio", "/favorites"];

/** The same-origin public reads the pages render from. CopyDog disallows
 * /api/ too, but its pages read api.copydog.xyz, another host whose own
 * robots.txt is absent (everything allowed); Orbie's pages read their data
 * through this origin's /api/hl, so a crawler that renders them (Googlebot
 * honours robots.txt for subresources) must be let fetch these, or every
 * page but the home is a skeleton to it. The longest matching rule wins, so
 * these open only their own prefixes; the live feed's event stream stays
 * closed (a renderer would wait on it). */
export const PUBLIC_READS = [
  "/api/hl/discover/",
  "/api/hl/traders",
  "/api/hl/kols/",
  "/api/hl/insights/",
  "/api/hl/settings",
  "/api/hl/actions",
  "/api/coin-icon/",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/", ...PUBLIC_READS], disallow: DISALLOWED }],
    sitemap: `${APP_URL}/sitemap.xml`,
  };
}
