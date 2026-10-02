import { appIconPng } from "@/lib/app-icon-image";

/** /icon-192.png for the web manifest. */
export function GET() {
  return appIconPng(192);
}
