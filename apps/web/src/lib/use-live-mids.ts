"use client";

import { useMemo, useSyncExternalStore } from "react";

import { getHyperliquidSocket } from "@/lib/hyperliquid-ws";

/** At most one re-render per second: chips don't need every tick. */
const NOTIFY_MS = 1_000;

type Mids = Readonly<Record<string, number>>;
const EMPTY: Mids = {};

/**
 * Live mids from `allMids` (not user-specific, so any page may use it) for
 * the given perp dexes ("" = main dex and spot). One store per dex set,
 * subscribed while a component uses it.
 */
class MidsStore {
  private mids: Mids = EMPTY;
  private readonly listeners = new Set<() => void>();
  private teardown: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly dexes: string[]) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  readonly getSnapshot = () => this.mids;

  private start() {
    const socket = getHyperliquidSocket();
    if (!socket) return;
    const offs = this.dexes.map((dex) =>
      socket.subscribe({ type: "allMids", dex }, (data) => {
        const mids = (data as { mids?: Record<string, string> }).mids;
        if (!mids) return;
        const next: Record<string, number> = { ...this.mids };
        for (const [key, value] of Object.entries(mids)) {
          const n = Number(value);
          if (Number.isFinite(n)) next[key] = n;
        }
        this.mids = next;
        this.timer ??= setTimeout(() => {
          this.timer = null;
          this.listeners.forEach((l) => l());
        }, NOTIFY_MS);
      }),
    );
    this.teardown = () => offs.forEach((off) => off());
  }

  private stop() {
    this.teardown?.();
    this.teardown = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

const stores = new Map<string, MidsStore>();
const noopSubscribe = () => () => undefined;
const empty = () => EMPTY;

/** Latest mid per coin for these dexes; empty until the first message
 * (and always during server rendering). */
export function useLiveMids(dexes: string[]): Mids {
  const key = dexes.length === 0 ? null : [...new Set(dexes)].sort().join(",");
  const store = useMemo(() => {
    if (key === null) return null;
    let s = stores.get(key);
    if (!s) {
      s = new MidsStore(key.split(","));
      stores.set(key, s);
    }
    return s;
  }, [key]);
  return useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getSnapshot ?? empty, empty);
}
