import { ImageResponse } from "next/og";

import { appIconSvg } from "@/components/brand/logo";

/** The orange app icon, full-bleed, as a PNG of `size` pixels (the
 * manifest's 192 and 512 icons; the same drawing as the apple icon). */
export function appIconPng(size: number): ImageResponse {
  const svg = appIconSvg(size, { rounded: false });
  return new ImageResponse(
    // eslint-disable-next-line @next/next/no-img-element
    <img alt="" width={size} height={size} src={`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`} />,
    { width: size, height: size, headers: { "Cache-Control": "public, max-age=86400" } },
  );
}
