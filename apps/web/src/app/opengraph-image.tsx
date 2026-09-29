import { ogAlt, renderOgCard } from "@/lib/og-card";

export const alt = ogAlt;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return renderOgCard();
}
