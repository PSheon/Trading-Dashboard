import { APP_NAME } from "@/lib/config";

/** Fills `{app}` in a catalog string. */
export function withApp(text: string): string {
  return text.replaceAll("{app}", APP_NAME);
}
