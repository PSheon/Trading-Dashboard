// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CjkFontWarmup } from "@/components/shell/cjk-font";
import { encodeCjkFont, parseCjkFont } from "@/lib/cjk-font";

vi.mock("next/navigation", () => ({ usePathname: () => "/explore" }));
vi.mock("@/components/shell/noto-font", () => ({ notoSansTc: { style: { fontFamily: "'Noto Sans TC', 'Noto Sans TC Fallback'" } } }));

const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
const layout = readFileSync(resolve(process.cwd(), "src/app/layout.tsx"), "utf8");
const notoModule = readFileSync(resolve(process.cwd(), "src/components/shell/noto-font.ts"), "utf8");

/** Paul, 2026-10-05 (「好修改」): no Noto Sans TC before LCP on a first visit. */
it("names the web font in no first-paint font stack, only under .cjk-web", () => {
  const stacks = css.match(/--font-(sans|display|heading|mono):[^;]+;/g) ?? [];
  expect(stacks).toHaveLength(4);
  for (const stack of stacks) expect(stack).not.toContain("--font-noto-tc");
  expect(css).toMatch(/:root\.cjk-web \{\s*--font-cjk: var\(--font-noto-tc, "Noto Sans TC"\), var\(--font-cjk-system\);/);
  // An installed "Noto Sans TC" would be shadowed by the web font's
  // @font-face of that name, so the system list leaves it out.
  expect(css).toMatch(/--font-cjk-system: "PingFang TC", "Hiragino Sans", "Microsoft JhengHei", "Noto Sans CJK TC";/);
  // Not in the layout's module graph at all (its @font-face rules would be
  // in the first paint's CSS); never preloaded, and optional.
  expect(layout).not.toMatch(/Noto_Sans_TC|from "@\/components\/shell\/noto-font"/);
  expect(notoModule).toMatch(/Noto_Sans_TC\(\{[^}]*display: "optional",[^}]*preload: false/);
});

it("links the cached stylesheet only for a cookie the warm-up wrote", () => {
  const css = ["/_next/static/chunks/2drf8omfxyj3z.css"];
  const family = "'Noto Sans TC', 'Noto Sans TC Fallback'";
  expect(parseCjkFont(encodeCjkFont({ css, family }))).toEqual({ css, family });
  expect(parseCjkFont(JSON.stringify({ css, family }))).toEqual({ css, family });
  expect(parseCjkFont(undefined)).toBeNull();
  expect(parseCjkFont("1")).toBeNull();
  expect(parseCjkFont(encodeCjkFont({ css: ["https://evil.example/x.css"], family }))).toBeNull();
  expect(parseCjkFont(encodeCjkFont({ css: ["/_next/static/../../x.css"], family }))).toBeNull();
  expect(parseCjkFont(encodeCjkFont({ css, family: "x</style><script>" }))).toBeNull();
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
/** The CSS chunk the dynamic import brought in, as the browser lists it. */
class FakeFontFaceRule { style = { getPropertyValue: () => "'Noto Sans TC'" }; }
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  load.mockClear();
  idle = undefined;
  Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
  Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
  Object.defineProperty(document, "styleSheets", { configurable: true, value: [{ href: "http://localhost/_next/static/chunks/noto.css", cssRules: [new FakeFontFaceRule()] }] });
  vi.stubGlobal("CSSFontFaceRule", FakeFontFaceRule);
  vi.stubGlobal("requestIdleCallback", (cb: () => void) => { idle = cb; return 1; });
  vi.stubGlobal("cancelIdleCallback", () => {});
  document.cookie = "cjk-font=; max-age=0; path=/";
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("fetches the page's CJK characters' slices a few seconds after load, then records the stylesheet in the cookie", async () => {
  text("探索 Explore 洞察");
  await act(async () => root.render(<CjkFontWarmup />));
  // Nothing at load: the page's own requests and its LCP go first.
  await act(async () => vi.advanceTimersByTime(4_000));
  expect(idle).toBeUndefined();
  await act(async () => vi.advanceTimersByTime(1_500));
  await act(async () => { idle?.(); await vi.dynamicImportSettled(); });
  expect(load).toHaveBeenCalledWith("500 16px 'Noto Sans TC'", expect.stringContaining("探索洞察"));
  expect(load).toHaveBeenCalledWith("700 16px 'Noto Sans TC'", expect.any(String));
  expect(String(load.mock.calls[0][1])).not.toMatch(/[A-Za-z]/);
  expect(parseCjkFont(document.cookie.match(/cjk-font=([^;]*)/)?.[1])).toEqual({ css: ["/_next/static/chunks/noto.css"], family: "'Noto Sans TC', 'Noto Sans TC Fallback'" });
  document.getElementById("t")?.remove();
});

it("asks for nothing on a page without CJK text", async () => {
  text("Explore");
  await act(async () => root.render(<CjkFontWarmup />));
  await act(async () => vi.advanceTimersByTime(6_000));
  await act(async () => { idle?.(); await vi.dynamicImportSettled(); });
  expect(load).not.toHaveBeenCalled();
  expect(document.cookie).not.toContain("cjk-font=");
  document.getElementById("t")?.remove();
});
