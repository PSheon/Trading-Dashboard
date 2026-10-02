"use client";

import { useSyncExternalStore } from "react";

/** Tailwind's `md`: the width where the desktop layout takes over. */
const DESKTOP = "(min-width: 768px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(DESKTOP);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Whether the desktop layout is the one on screen; `undefined` on the
 * server and until the page has hydrated. For pages whose phone and desktop
 * layouts are different component trees with their own data: mounting both
 * and hiding one with CSS makes a phone run (and poll for) everything only
 * the desktop draws. Use it where the content arrives after hydration
 * anyway; while it is `undefined`, show the loading state.
 */
export function useIsDesktop(): boolean | undefined {
  return useSyncExternalStore<boolean | undefined>(subscribe, () => window.matchMedia(DESKTOP).matches, () => undefined);
}
