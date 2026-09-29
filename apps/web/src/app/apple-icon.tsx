import { ImageResponse } from "next/og";

import { appIconSvg } from "@/components/brand/logo";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Home-screen icon: the orange app icon, full-bleed (iOS rounds it). */
export default function AppleIcon() {
  const svg = appIconSvg(180, { rounded: false });
  return new ImageResponse(
    (
      <img
        alt=""
        width={180}
        height={180}
        src={`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`}
      />
    ),
    size,
  );
}
