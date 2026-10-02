import { appIconPng } from "@/lib/app-icon-image";

/** /icon-512.png for the web manifest. */
export function GET() {
  return appIconPng(512);
}
