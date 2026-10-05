// @vitest-environment happy-dom
import { existsSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { RouteError } from "../src/components/route-error";
import { LOCALES } from "../src/i18n/config";
import { catalogs } from "../src/i18n/messages";
import { GLOBAL_ERROR_TEXT } from "../src/lib/global-error-text";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

describe("error boundaries", () => {
  it("shows one line, a retry that calls the boundary, and the way home — and nothing of the error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const error = Object.assign(new Error("secret database detail"), { digest: "abc123" });
    await act(async () => root.render(<RouteError error={error} retry={retry} title="Failed to load" retryLabel="Retry" homeLabel="Back to Leaderboard" />));
    expect(host.querySelector('[role="alert"] h1')?.textContent).toBe("Failed to load");
    expect(host.textContent).not.toContain("secret");
    expect(host.textContent).not.toContain("abc123");
    // Home in the page's language (zh-TW outside a provider).
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/zh-TW");
    await act(async () => host.querySelector("button")!.click());
    expect(retry).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(error);
    await act(async () => root.unmount());
    log.mockRestore();
  });

  it("the global boundary's built-in strings are the catalogs', in all eleven languages", () => {
    for (const locale of LOCALES) {
      const m = catalogs[locale];
      expect(GLOBAL_ERROR_TEXT[locale], locale).toEqual({ title: m.common.error, retry: m.common.retry, home: m.notFound.home });
    }
  });

  it("routes that answer 404 by themselves have no loading boundary above them", () => {
    // A loading.tsx starts the response (HTTP 200) before the page can call
    // notFound(), which would turn these real 404s back into soft ones.
    const root = join(import.meta.dirname, "../src/app");
    const app = join(root, "[locale]");
    for (const dir of ["", "trader", "trader/[address]", "coins", "coins/[coin]", "[...missing]", "dev"]) {
      expect(existsSync(join(app, dir, "loading.tsx")), `app/${dir}/loading.tsx`).toBe(false);
    }
    for (const dir of ["explore", "insights", "favorites", "portfolio", "settings", "admin"]) {
      expect(existsSync(join(app, dir, "loading.tsx")), `app/${dir}/loading.tsx`).toBe(true);
    }
    for (const file of ["error.tsx", "not-found.tsx"]) expect(existsSync(join(app, file)), file).toBe(true);
    expect(existsSync(join(root, "global-error.tsx"))).toBe(true);
  });
});
