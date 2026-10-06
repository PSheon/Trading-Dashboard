import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { NOT_FOUND_HEADER, PAGE_ROUTES, isStaticNotFound, matchPageRoute } from "../src/lib/page-routes";
import { proxy } from "../src/proxy";

const LOCALE_DIR = join(__dirname, "../src/app/[locale]");

/** Every page.tsx under app/[locale], as its route ("/coins/[coin]"),
 * route groups dropped, the catch-all left out. */
function pagesOnDisk(dir = LOCALE_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...pagesOnDisk(path));
    else if (entry === "page.tsx") {
      const route = "/" + relative(LOCALE_DIR, dir).split(sep).filter((segment) => segment && !/^\(.+\)$/.test(segment)).join("/");
      found.push(route === "/" ? "/" : route.replace(/\/$/, ""));
    }
  }
  return found;
}

describe("the proxy's page table", () => {
  it("is exactly the pages on disk, so a new page can't be answered 404", () => {
    const disk = pagesOnDisk().filter((route) => route !== "/[...missing]").sort();
    expect([...PAGE_ROUTES].sort()).toEqual(disk);
  });

  it("matches as Next does: static before dynamic, optional catch-alls take their parent", () => {
    expect(matchPageRoute("/")).toBe("/");
    expect(matchPageRoute("/explore")).toBe("/explore");
    expect(matchPageRoute("/explore/")).toBe("/explore");
    expect(matchPageRoute("/coins/BTC")).toBe("/coins/[coin]");
    expect(matchPageRoute("/dev")).toBe("/dev/[[...preview]]");
    expect(matchPageRoute("/dev/buttons")).toBe("/dev/buttons");
    expect(matchPageRoute("/dev/c/home")).toBe("/dev/[[...preview]]");
    expect(matchPageRoute("/explore/all")).toBeNull();
    expect(matchPageRoute("/zz-no-such-page")).toBeNull();
    expect(matchPageRoute("/admin/revenue")).toBeNull();
    expect(matchPageRoute("/trader")).toBeNull();
  });

  it("knows the 404s it can decide alone, and leaves the api's to the page", () => {
    for (const path of ["/zh-TW/zz-no-such-page", "/en/a/b/c", "/en/trader/0x1234", "/en/trader/%E0%A4%A", "/en/coins/a%20b", "/en/explore/all"]) {
      expect(isStaticNotFound(path), path).toBe(true);
    }
    for (const path of ["/zh-TW", "/en/explore", "/en/trader/0x0000000000000000000000000000000000000000", "/en/coins/BTC", "/en/coins/xyz-TSLA", "/en/r/ABCD", "/en/dev/buttons"]) {
      expect(isStaticNotFound(path), path).toBe(false);
    }
  });
});

/** The request headers NextResponse.next({ request }) forwards. */
const forwarded = (response: Response, name: string) => response.headers.get(`x-middleware-request-${name}`);

describe("the proxy answers a 404 it can decide with the status, before the page renders", () => {
  it("sets 404 and marks the request for the page and the title", () => {
    for (const path of ["/zh-TW/zz-no-such-page", "/en/trader/0x1234"]) {
      const response = proxy(new NextRequest(`https://app.orbie.fun${path}`));
      expect(response.status, path).toBe(404);
      expect(forwarded(response, NOT_FOUND_HEADER), path).toBe("1");
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
    }
  });

  it("leaves real pages alone and drops the mark when a visitor sends it", () => {
    const response = proxy(new NextRequest("https://app.orbie.fun/en/explore", { headers: { [NOT_FOUND_HEADER]: "1" } }));
    expect(response.status).toBe(200);
    expect(forwarded(response, NOT_FOUND_HEADER)).toBeNull();
    expect(response.headers.get("x-middleware-override-headers")).not.toContain(NOT_FOUND_HEADER);
  });
});

describe("the 404 pages", () => {
  it("render the 404 themselves when the proxy answered, instead of throwing into an empty document", () => {
    const missing = readFileSync(join(LOCALE_DIR, "[...missing]/page.tsx"), "utf8");
    expect(missing).toContain("renderNotFound()");
    expect(missing).not.toMatch(/\bnotFound\(\)/);
    const trader = readFileSync(join(LOCALE_DIR, "trader/[address]/page.tsx"), "utf8");
    expect(trader).toMatch(/if \(!ADDRESS\.test\(address\)\) return renderNotFound\(\);/);
  });
});
