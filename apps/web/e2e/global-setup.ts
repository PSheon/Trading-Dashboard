import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { FullConfig } from "@playwright/test";

/**
 * Compiles every route of the fixture server before the first test.
 *
 * The server is `next dev`, which compiles a route the first time it is
 * asked for. A test that clicked a link to a route nobody had opened yet
 * waited for that compile inside a 5 s `toHaveURL`, and passed or failed by
 * the speed of the machine (copy-controls "pause and resume" in CI). Paying
 * for the compiles here, once and outside any test's clock, removes the
 * race; next.config.ts keeps the compiled routes for the whole run.
 */
const SAMPLE: Record<string, string> = {
  "[address]": "0x89da4baec446f35a1cbe17a9d1ee5c70b05ee43f",
  "[coin]": "BTC",
  "[id]": "2",
  "[[...preview]]": "",
  "[...missing]": "no-such-page",
};

/** Every `page.tsx` under src/app as a URL path, dynamic segments filled in. */
export function routes(appDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === "page.tsx") {
        const segments = relative(appDir, dir).split(sep).filter(Boolean).map((segment) => {
          if (!segment.startsWith("[")) return segment;
          if (!(segment in SAMPLE)) throw new Error(`e2e/global-setup.ts has no sample value for the route segment ${segment}`);
          return SAMPLE[segment];
        });
        found.push(`/${segments.filter(Boolean).join("/")}`);
      }
    }
  };
  walk(appDir);
  return found.sort();
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("global setup needs use.baseURL");
  const started = Date.now();
  const paths = routes(join(config.rootDir, "../src/app"));
  // One at a time: the compiles share one webpack and one core in CI.
  for (const path of paths) {
    const response = await fetch(new URL(path, baseURL), { headers: { cookie: "locale=en" }, signal: AbortSignal.timeout(300_000) });
    await response.arrayBuffer();
    // The lab's crash page answers 500 on purpose (e2e/error-boundary.spec.ts).
    if (response.status >= 500 && path !== "/dev/crash") throw new Error(`Warming ${path} answered ${response.status}`);
  }
  console.log(`Compiled ${paths.length} routes in ${Math.round((Date.now() - started) / 1000)} s`);
}
