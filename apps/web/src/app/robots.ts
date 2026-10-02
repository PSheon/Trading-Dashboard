import type { MetadataRoute } from "next";

import { APP_URL } from "@/lib/config";

/** Paths no crawler should fetch: the api forwarder, the back office, the
 * design lab, and the personal pages (which also carry `noindex`), as
 * CopyDog's robots.txt does for its own. */
export const DISALLOWED = ["/api/", "/admin", "/dev", "/settings", "/portfolio", "/favorites"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: DISALLOWED }],
    sitemap: `${APP_URL}/sitemap.xml`,
  };
}
