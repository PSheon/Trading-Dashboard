import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { CHROME, chromeFor } from "../src/components/shell/chrome";

const LOCALE_DIR = join(__dirname, "../src/app/[locale]");
const isGroup = (name: string) => /^\(.+\)$/.test(name);

/** Every page under app/[locale] as [group, route]. */
function pages(dir = LOCALE_DIR): Array<[string | null, string]> {
  const found: Array<[string | null, string]> = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...pages(path));
    else if (entry === "page.tsx") {
      const segments = relative(LOCALE_DIR, dir).split(sep).filter(Boolean);
      const group = segments[0] && isGroup(segments[0]) ? segments[0] : null;
      found.push([group, "/" + segments.filter((s) => !isGroup(s)).join("/")]);
    }
  }
  return found;
}

describe("route groups own the page chrome", () => {
  it("has one chrome per group folder, and no other", () => {
    const folders = readdirSync(LOCALE_DIR).filter((e) => isGroup(e) && statSync(join(LOCALE_DIR, e)).isDirectory());
    expect(folders.sort()).toEqual(Object.keys(CHROME).sort());
  });

  it("puts every page in a group", () => {
    expect(pages().filter(([group]) => group === null)).toEqual([]);
  });

  it("gives each page the chrome it had when the shell matched paths", () => {
    const summary = (route: string) => {
      const group = pages().find(([, r]) => r === route)?.[0] ?? null;
      const c = chromeFor(group);
      return c ? `${c.phoneHeader ?? "-"} ${c.tabBar ? "tabs" : "-"} ${c.footer ? "footer" : "-"}` : "no shell";
    };
    const expected: Record<string, string> = {
      "/": "app tabs footer",
      "/explore": "app tabs footer",
      "/insights": "app tabs footer",
      "/favorites": "app tabs footer",
      "/settings": "app tabs footer",
      "/portfolio": "app tabs footer",
      "/trader/[address]": "app - footer",
      "/coins": "- - footer",
      "/coins/[coin]": "- - footer",
      "/admin": "- tabs -",
      "/admin/users": "- tabs -",
      "/about": "menu - footer",
      "/help": "menu - footer",
      "/privacy": "menu - footer",
      "/terms": "menu - footer",
      "/delete-account": "menu - footer",
      "/r/[code]": "menu - footer",
      "/[...missing]": "menu - -",
      "/dev/buttons": "no shell",
    };
    for (const [route, chrome] of Object.entries(expected)) expect(summary(route), route).toBe(chrome);
    expect(CHROME["(detail)"].noFooterOnInsightsTab).toBe(true);
    expect(CHROME["(app-fill)"].fill).toBe(true);
  });
});
