import { ogSize } from "@/lib/og-card";
import TraderOpengraphImage from "./opengraph-image";

export const alt = "Trader PnL card";
export const size = ogSize;
export const contentType = "image/png";

/** The same card for X (the root's twitter-image would otherwise win). */
export default function TraderTwitterImage(props: { params: Promise<{ address: string }> }) {
  return TraderOpengraphImage(props);
}
