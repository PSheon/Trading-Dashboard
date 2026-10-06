// @vitest-environment happy-dom
import { ArrowRight } from "lucide-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";

/** Every pending button (Paul, 2026-10-06): Orbie's orbit mark in the
 * icon's place, no second press, the same width, at least 300 ms. */
let host: HTMLDivElement, root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); vi.useFakeTimers(); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
const button = () => host.querySelector("button")!;

it("shows the orbit mark in the icon's place and refuses a second press while loading", () => {
  const onClick = vi.fn();
  act(() => root.render(<Button loading onClick={onClick}><ArrowRight data-testid="icon" />開始跟單</Button>));
  expect(button().getAttribute("aria-busy")).toBe("true");
  expect(button().dataset.loading).toBe("true");
  expect(button().querySelector("[data-orbit-spinner]")).not.toBeNull();
  expect(button().textContent).toContain("開始跟單");
  // The icon is hidden by the busy style, the label stays, the colour stays (not disabled).
  expect(button().className).toContain("data-[loading=true]:[&>svg:not([data-orbit-spinner])]:hidden");
  // Busy is disabled (Paul, 2026-10-06), drawn at 70% so the mark reads.
  expect(button().disabled).toBe(true);
  expect(button().className).toContain("data-[loading=true]:disabled:opacity-70");
  act(() => button().click());
  expect(onClick).not.toHaveBeenCalled();
});

it("keeps the mark for at least 300 ms after a fast answer, then lets the button be pressed again", () => {
  const onClick = vi.fn();
  act(() => root.render(<Button loading onClick={onClick}>確認並開始</Button>));
  act(() => root.render(<Button loading={false} onClick={onClick}>確認並開始</Button>));
  expect(button().getAttribute("aria-busy")).toBe("true");
  act(() => { vi.advanceTimersByTime(300); });
  expect(button().getAttribute("aria-busy")).toBeNull();
  expect(button().querySelector("[data-orbit-spinner]")).toBeNull();
  act(() => button().click());
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("is an ordinary button when not loading", () => {
  const onClick = vi.fn();
  act(() => root.render(<Button onClick={onClick}>開始跟單</Button>));
  expect(button().getAttribute("aria-busy")).toBeNull();
  expect(button().querySelector("[data-orbit-spinner]")).toBeNull();
  act(() => button().click());
  expect(onClick).toHaveBeenCalledTimes(1);
});

it("is a client component, and its styles are importable by server components (the 404 page)", async () => {
  const [{ readFileSync }, { join }] = await Promise.all([import("node:fs"), import("node:path")]);
  const read = (file: string) => readFileSync(join(process.cwd(), "src/components/ui", file), "utf8");
  // `loading` keeps state: rendered from a server component (not-found.tsx)
  // without the directive, every 404 crashed (CI run 37418783090).
  expect(read("button.tsx").trimStart().startsWith('"use client"')).toBe(true);
  expect(read("button-variants.ts")).not.toMatch(/^\s*["']use client["']/);
});
