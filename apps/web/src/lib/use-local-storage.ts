"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A localStorage value as external state. `undefined` while rendering on
 * the server / hydrating, `null` when unset or when storage is blocked.
 */
const EVENT = "local-storage-change";

export function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocalStorage(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // storage blocked: the value just doesn't persist
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

export function useLocalStorage(key: string): [string | null | undefined, (value: string | null) => void] {
  const value = useSyncExternalStore<string | null | undefined>(
    subscribe,
    () => readLocalStorage(key),
    () => undefined,
  );
  const set = useCallback((next: string | null) => writeLocalStorage(key, next), [key]);
  return [value, set];
}
