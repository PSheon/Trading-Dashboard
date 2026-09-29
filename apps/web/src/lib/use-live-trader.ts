"use client";

import { useMemo, useSyncExternalStore } from "react";

import type { TraderFill, TraderProfileResponse } from "@/lib/contracts";
import { getHyperliquidSocket, type ConnectionStatus, type HlSubscription } from "@/lib/hyperliquid-ws";
import {
  deriveLiveProfile,
  initialLiveState,
  liveTraderReducer,
  traderSubscriptions,
  type LiveEvent,
  type LiveTraderState,
} from "@/lib/live-trader";

/** Re-render at most this often however fast messages arrive (ten dexes'
 * states and mids every few seconds). */
const NOTIFY_MS = 250;

interface Snapshot {
  state: LiveTraderState;
  status: ConnectionStatus;
}

const IDLE: Snapshot = { state: initialLiveState, status: "idle" };

/**
 * The live state of one trader page: subscribes on its first React
 * listener, unsubscribes on its last (the page unmounting), so only the open
 * trader page holds user subscriptions. While the socket isn't open the
 * state is dropped; the page shows REST data until the resubscribed
 * snapshots arrive.
 */
class LiveTraderStore {
  private snapshot: Snapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private teardown: (() => void) | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly key: string,
    private readonly address: string,
    private readonly dexes: string[],
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  readonly getSnapshot = (): Snapshot => this.snapshot;

  /** Streaming account data right now. */
  get streaming(): boolean {
    return this.snapshot.status === "open" && this.snapshot.state.updatedAt !== null;
  }

  private start() {
    const socket = getHyperliquidSocket();
    if (!socket) return;
    const offs = traderSubscriptions(this.address, this.dexes).map((sub) =>
      socket.subscribe(sub, (data) => this.apply(toEvent(sub, data))),
    );
    const offStatus = socket.onStatus((status) => {
      // Stale live data must not linger over fresher REST data while
      // disconnected; the resubscribe snapshots rebuild it.
      this.snapshot = { state: status === "open" ? this.snapshot.state : initialLiveState, status };
      this.notify(true);
    });
    this.snapshot = { ...this.snapshot, status: socket.status };
    this.teardown = () => {
      offs.forEach((off) => off());
      offStatus();
    };
    stores.set(this.key, this);
  }

  private stop() {
    this.teardown?.();
    this.teardown = null;
    if (this.notifyTimer !== null) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    this.snapshot = IDLE;
    if (stores.get(this.key) === this) stores.delete(this.key);
  }

  private apply(event: LiveEvent | null) {
    if (!event) return;
    const state = liveTraderReducer(this.snapshot.state, event);
    if (state === this.snapshot.state) return;
    this.snapshot = { ...this.snapshot, state };
    this.notify(false);
  }

  private notify(now: boolean) {
    const flush = () => {
      this.notifyTimer = null;
      for (const listener of [...this.listeners]) listener();
    };
    if (now) {
      if (this.notifyTimer !== null) clearTimeout(this.notifyTimer);
      flush();
      return;
    }
    this.notifyTimer ??= setTimeout(flush, NOTIFY_MS);
  }
}

function toEvent(sub: HlSubscription, data: unknown): LiveEvent | null {
  if (!data || typeof data !== "object") return null;
  const at = Date.now();
  switch (sub.type) {
    case "clearinghouseState":
      return { type: "clearinghouseState", data: data as never, at };
    case "spotState":
      return { type: "spotState", data: data as never, at };
    default:
      return { type: sub.type, data: data as never } as LiveEvent;
  }
}

const stores = new Map<string, LiveTraderStore>();
const pending = new Map<string, LiveTraderStore>();

function storeFor(address: string, dexes: string[]): LiveTraderStore {
  const key = `${address}|${dexes.join(",")}`;
  const existing = stores.get(key) ?? pending.get(key);
  if (existing) return existing;
  const store = new LiveTraderStore(key, address, dexes);
  // Held until React subscribes (then it moves to `stores`); a render that
  // never commits leaves only this small entry behind, replaced next time.
  pending.clear();
  pending.set(key, store);
  return store;
}

/** Whether a trader page is streaming this address right now, for
 * slowing its REST polling. */
export function isStreamingTrader(address: string): boolean {
  const prefix = `${address.toLowerCase()}|`;
  for (const [key, store] of stores) if (key.startsWith(prefix) && store.streaming) return true;
  return false;
}

const noopSubscribe = () => () => undefined;
const idleSnapshot = () => IDLE;

export type LiveStatus = "live" | "connecting" | "polling";

export interface LiveTrader {
  /** The REST profile with live data laid over it (undefined until the REST
   * profile loads). */
  profile: TraderProfileResponse | undefined;
  /** Perp fills seen live, newest first (merge with the REST list). */
  fills: TraderFill[];
  /** Latest mid per coin ("BTC", "xyz:TSLA", "@107"). */
  mids: Record<string, number>;
  status: LiveStatus;
}

/**
 * Live data for the trader page. Subscribes (browser only; nothing during
 * server rendering) once the REST profile is in, since it names the perp
 * dexes to subscribe to, and unsubscribes when the page unmounts.
 */
export function useLiveTrader(address: string, profile: TraderProfileResponse | undefined): LiveTrader {
  const dexKey = profile?.perpDexes.join(",");
  const store = useMemo(
    () => (dexKey === undefined ? null : storeFor(address.toLowerCase(), dexKey === "" ? [] : dexKey.split(","))),
    [address, dexKey],
  );
  const snap = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getSnapshot ?? idleSnapshot, idleSnapshot);
  const open = snap.status === "open";
  const merged = useMemo(
    () => (profile && open ? deriveLiveProfile(profile, snap.state) : profile),
    [profile, open, snap.state],
  );
  // A first connect shows "connecting"; a dropped connection retrying with
  // backoff is a fallback to REST polling, and says so.
  const status: LiveStatus =
    open && snap.state.updatedAt !== null ? "live" : snap.status === "connecting" || open ? "connecting" : "polling";
  return { profile: merged, fills: open ? snap.state.fills : [], mids: snap.state.mids, status };
}
