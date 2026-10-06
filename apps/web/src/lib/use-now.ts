"use client";

import { useSyncExternalStore } from "react";

/**
 * The current time for relative labels ("3 小時前"), ticking every 30 s
 * while anything is subscribed. Components stay pure (no `Date.now()` in
 * render) and all subscribers share one timer and one value.
 *
 * 0 on the server and while hydrating (web audit M8): a server process's
 * clock read once would be days stale, and any time it rendered could
 * differ from the browser's. A component renders nothing time-dependent
 * while it is 0; the real time arrives right after hydration.
 */
const TICK_MS = 30_000;

let now = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): number {
  if (now === 0) now = Date.now();
  return now;
}

const getServerSnapshot = () => 0;

export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
