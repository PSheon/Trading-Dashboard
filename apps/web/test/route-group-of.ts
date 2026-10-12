import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { matchPageRoute } from "../src/lib/page-routes";

const LOCALE_DIR = join(__dirname, "../src/app/[locale]");
const isGroup = (name: string) => /^\(.+\)$/.test(name);

/** route ("/coins/[coin]") → its route group folder ("(bare)"), from disk. */
function groups(dir = LOCALE_DIR, out = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) groups(path, out);
    else if (entry === "page.tsx") {
      const segments = relative(LOCALE_DIR, dir).split(sep).filter(Boolean);
      out.set("/" + segments.filter((s) => !isGroup(s)).join("/"), segments[0]!);
    }
  }
  return out;
}
const GROUPS = groups();

/** What `useSelectedLayoutSegment()` returns in the root layout for a path
 * (after the locale): the group of the page Next serves it with, the
 * catch-all's for a path no page matches. For tests that mock next/navigation. */
export function routeGroupOf(pathname: string): string | null {
  return GROUPS.get(matchPageRoute(pathname) ?? "/[...missing]") ?? null;
}
