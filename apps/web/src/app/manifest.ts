import type { MetadataRoute } from "next";

import { catalogs } from "@/i18n/messages";
import { APP_NAME } from "@/lib/config";
import { withApp } from "@/lib/seo-text";
import { THEME_COLOR } from "@/lib/theme";

/** The web app manifest (CopyDog serves one at /manifest.json): name, the
 * Orbit light page colour (the default theme of a fresh visit) and the
 * home-screen icons. One language: a manifest
 * is fetched without the visitor's cookie. */
export default function manifest(): MetadataRoute.Manifest {
  const m = catalogs.en.meta;
  return {
    name: `${APP_NAME} - ${m.appShort}`,
    short_name: APP_NAME,
    description: withApp(m.app),
    start_url: "/",
    display: "standalone",
    background_color: THEME_COLOR.light,
    theme_color: THEME_COLOR.light,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
