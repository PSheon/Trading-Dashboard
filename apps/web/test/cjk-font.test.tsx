// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CjkFontWarmup } from "@/components/shell/cjk-font";

vi.mock("next/navigation", () => ({ usePathname: () => "/explore" }));

const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
const layout = readFileSync(resolve(process.cwd(), "src/app/layout.tsx"), "utf8");

/** Paul, 2026-10-05 (「好修改」): no Noto Sans TC before LCP on a first visit. */
it("names the web font in no first-paint font stack, only under .cjk-web", () => {
  const stacks = css.match(/--font-(sans|display|heading|mono):[^;]+;/g) ?? [];
  expect(stacks).toHaveLength(4);
  for (const stack of stacks) expect(stack).not.toContain("--font-noto-tc");
  expect(css).toMatch(/:root\.cjk-web \{\s*--font-cjk: var\(--font-noto-tc\), var\(--font-cjk-system\);/);
  // An installed "Noto Sans TC" would be shadowed by the web font's
  // @font-face of that name, so the system list leaves it out.
  expect(css).toMatch(/--font-cjk-system: "PingFang TC", "Hiragino Sans", "Microsoft JhengHei", "Noto Sans CJK TC";/);
  // Never preloaded, and optional: a slice that is late is never swapped in.
  expect(layout).toMatch(/Noto_Sans_TC\(\{[^}]*display: "optional",[^}]*preload: false/);
});

let root: Root, container: HTMLDivElement;
const text = (value: string) => {
  const p = document.createElement("p");
  p.id = "t";
  p.textContent = value;
  document.body.prepend(p);
};
const load = vi.fn<(font: string, text?: string) => Promise<unknown[]>>(async () => [{}]);
let idle: (() => void) | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  load.mockClear();
  idle = undefined;
  Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
  Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
  vi.stubGlobal("requestIdleCallback", (cb: () => void) => { idle = cb; return 1; });
  vi.stubGlobal("cancelIdleCallback", () => {});
  document.documentElement.style.setProperty("--font-noto-tc", "'Noto Sans TC', 'Noto Sans TC Fallback'");
  document.cookie = "cjk-font=; max-age=0; path=/";
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("fetches the page's CJK characters' slices once the browser is idle, then sets the cookie", async () => {
  text("探索 Explore 洞察");
  await act(async () => root.render(<CjkFontWarmup />));
  // Nothing before the idle moment: the page's own requests go first.
  expect(load).not.toHaveBeenCalled();
  await act(async () => idle?.());
  expect(load).toHaveBeenCalledWith("500 16px 'Noto Sans TC'", expect.stringContaining("探索洞察"));
  expect(load).toHaveBeenCalledWith("700 16px 'Noto Sans TC'", expect.any(String));
  expect(String(load.mock.calls[0][1])).not.toMatch(/[A-Za-z]/);
  expect(document.cookie).toContain("cjk-font=1");
  document.getElementById("t")?.remove();
});

it("asks for nothing on a page without CJK text", async () => {
  text("Explore");
  await act(async () => root.render(<CjkFontWarmup />));
  await act(async () => idle?.());
  expect(load).not.toHaveBeenCalled();
  expect(document.cookie).not.toContain("cjk-font=1");
  document.getElementById("t")?.remove();
});
