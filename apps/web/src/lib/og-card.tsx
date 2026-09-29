import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

import { BRAND, markSvgBody } from "@/components/brand/logo";
import { catalogs } from "@/i18n/messages";
import { APP_NAME } from "@/lib/config";

export const ogSize = { width: 1200, height: 630 };
export const ogAlt = `${APP_NAME} — ${catalogs.en.meta.tagline}`;

/**
 * Social card (Open Graph + Twitter): the dark lockup and the tagline on
 * brand navy. The bundled font is a Fredoka 600 subset that covers only the
 * letters of "orbie" and the tagline; a different NEXT_PUBLIC_APP_NAME needs
 * a new subset (see apps/web/README.md).
 */
export async function renderOgCard() {
  const fredoka = await readFile(join(process.cwd(), "src/assets/fredoka-600-subset.ttf"));
  const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${markSvgBody("dark", 220)}</svg>`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: `radial-gradient(circle at 50% 38%, #2a2552 0%, ${BRAND.navy} 55%, #0f0d1f 100%)`,
          color: BRAND.cream,
          fontFamily: "Fredoka",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt=""
            width={220}
            height={220}
            src={`data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`}
          />
          <div style={{ fontSize: 190, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1 }}>
            {APP_NAME.toLowerCase()}
          </div>
        </div>
        <div style={{ marginTop: 28, fontSize: 52, fontWeight: 600, color: "#b9b5d0" }}>
          {catalogs.en.meta.tagline}
        </div>
      </div>
    ),
    {
      ...ogSize,
      fonts: [{ name: "Fredoka", data: fredoka, weight: 600, style: "normal" }],
    },
  );
}
