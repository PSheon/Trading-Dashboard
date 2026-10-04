import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

import { BRAND, markSvgBody } from "@/components/brand/logo";
import { catalogs } from "@/i18n/messages";
import { APP_NAME } from "@/lib/config";

export const ogSize = { width: 1200, height: 630 };
export const ogAlt = `${APP_NAME} — ${catalogs.en.meta.tagline}`;

/**
 * Social card (Open Graph + Twitter): Orbit's light look — the ink lockup
 * and the tagline on the cream page, with soft orange and violet orbits. The bundled font is a Fredoka 600 subset that covers only the
 * letters of "orbie" and the tagline; a different NEXT_PUBLIC_APP_NAME needs
 * a new subset (see apps/web/README.md).
 */
export async function renderOgCard() {
  const fredoka = await readFile(join(process.cwd(), "src/assets/fredoka-600-subset.ttf"));
  const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${markSvgBody("light", 220)}</svg>`;

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
          background: `radial-gradient(circle at 12% 18%, #ffe1d0 0%, rgba(255,225,208,0) 38%), radial-gradient(circle at 88% 85%, #e9e0ff 0%, rgba(233,224,255,0) 40%), ${BRAND.cream}`,
          color: "#15132b",
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
        <div style={{ marginTop: 28, fontSize: 52, fontWeight: 600, color: "#5a5674" }}>
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
