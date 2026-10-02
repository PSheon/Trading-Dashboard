// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { useIsDesktop } from "../src/lib/use-is-desktop";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  const desktop = useIsDesktop();
  return <p>{desktop === undefined ? "unknown" : desktop ? "desktop" : "phone"}</p>;
}

function stubMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const query = { matches, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) };
  vi.stubGlobal("matchMedia", (text: string) => {
    expect(text).toBe("(min-width: 768px)");
    return query;
  });
  window.matchMedia = globalThis.matchMedia;
  return { set: (value: boolean) => { query.matches = value; for (const fn of listeners) fn(); }, listeners };
}

afterEach(() => vi.unstubAllGlobals());

it("is unknown on the server, then the layout on screen, and follows a resize", async () => {
  const media = stubMedia(false);
  expect(renderToString(<Probe />)).toContain("unknown");
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<Probe />));
  expect(host.textContent).toBe("phone");
  await act(async () => media.set(true));
  expect(host.textContent).toBe("desktop");
  await act(async () => root.unmount());
  expect(media.listeners.size).toBe(0);
});
