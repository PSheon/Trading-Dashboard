"use client";

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  globalThis.addEventListener?.("popstate", listener);
  return () => { listeners.delete(listener); globalThis.removeEventListener?.("popstate", listener); };
}

/**
 * One view setting kept in the URL's query (as Explore's boards do), so a
 * shared link opens the same view: read from the URL, written back with
 * `history.replaceState` (no navigation, no new history entry). Only its own
 * key is touched, so Privy's OAuth callback parameters stay; the default
 * value is left out of the URL. The server render uses the default and the
 * client takes the URL's value right after hydration.
 */
export function useUrlState<T extends string>(key: string, options: readonly T[], fallback: T): [T, (value: T) => void] {
  const read = () => {
    const raw = new URLSearchParams(globalThis.location?.search ?? "").get(key);
    return raw !== null && (options as readonly string[]).includes(raw) ? (raw as T) : fallback;
  };
  const value = useSyncExternalStore(subscribe, read, () => fallback);
  const update = useCallback((next: T) => {
    const qs = new URLSearchParams(globalThis.location.search);
    if (next === fallback) qs.delete(key); else qs.set(key, next);
    const url = `${globalThis.location.pathname}${qs.size ? `?${qs}` : ""}${globalThis.location.hash}`;
    if (url !== `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`) globalThis.history.replaceState(globalThis.history.state, "", url);
    listeners.forEach(listener => listener());
  }, [key, fallback]);
  return [value, update];
}
