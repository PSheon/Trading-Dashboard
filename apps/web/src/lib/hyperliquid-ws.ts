/**
 * The browser's own connection to Hyperliquid's WebSocket
 * (wss://api.hyperliquid.xyz/ws). Live data on the trader page comes straight
 * from Hyperliquid, so it costs our api nothing and counts against the
 * viewer's IP, not ours.
 *
 * One connection per tab (`getHyperliquidSocket()`), shared by every
 * component. Subscriptions are reference-counted: the first listener of a
 * subscription sends `subscribe`, the last one to leave sends
 * `unsubscribe`, and the socket closes a little after nothing is
 * subscribed. The connection is kept alive with `{"method":"ping"}` (the
 * server closes a connection it hasn't heard from in 60 s), treated as dead
 * when nothing has arrived for a while, and reopened with exponential
 * backoff, resubscribing everything.
 *
 * Limits (hyperliquid.gitbook.io → API → rate limits and user limits,
 * checked 2026-09-29): 10 connections, 1000 subscriptions and at most 10
 * unique users across user-specific subscriptions per IP. Only the open
 * trader page subscribes to a user, so a tab uses one user at a time.
 *
 * Never opens anything during server rendering: `getHyperliquidSocket()`
 * returns null outside the browser.
 */

export const HYPERLIQUID_WS_URL = "wss://api.hyperliquid.xyz/ws";

/** The subscriptions this app uses (verified live 2026-09-29; `webData2`
 * no longer exists: the server answers it with a parse error). */
export type HlSubscription =
  | { type: "allMids"; dex?: string }
  | { type: "clearinghouseState"; user: string; dex?: string }
  | { type: "spotState"; user: string }
  | { type: "userFills"; user: string; aggregateByTime?: boolean }
  | { type: "userTwapSliceFills"; user: string }
  | { type: "webData3"; user: string };

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting";

/** The part of the browser's WebSocket this client uses; tests pass a fake. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface HyperliquidSocketOptions {
  url?: string;
  createSocket?: (url: string) => WebSocketLike;
  clock?: Clock;
  /** How often to ping; the server drops a connection silent for 60 s. */
  pingIntervalMs?: number;
  /** Reconnect when nothing (not even a pong) arrived for this long. */
  staleAfterMs?: number;
  /** Close the socket this long after the last subscription left. */
  idleCloseMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** 0–1; spreads reconnects (±20%). */
  random?: () => number;
}

type Listener = (data: unknown) => void;

/** Routing key: the fields a message carries back to name its
 * subscription. `aggregateByTime` isn't echoed in `userFills` data, so this
 * app always subscribes without it. */
export function subscriptionKey(sub: HlSubscription): string {
  const user = "user" in sub ? sub.user.toLowerCase() : "";
  const dex = "dex" in sub ? (sub.dex ?? "") : "";
  return `${sub.type}|${user}|${dex}`;
}

/** The routing key of an incoming message, or null for control messages
 * (`subscriptionResponse`, `pong`, `error`) and unknown channels. */
export function messageKey(message: { channel?: unknown; data?: unknown }): string | null {
  const data = (message.data ?? {}) as Record<string, unknown>;
  const user = (u: unknown) => (typeof u === "string" ? u.toLowerCase() : "");
  const dex = (d: unknown) => (typeof d === "string" ? d : "");
  switch (message.channel) {
    case "allMids":
      return `allMids||${dex(data.dex)}`;
    case "clearinghouseState":
      return `clearinghouseState|${user(data.user)}|${dex(data.dex)}`;
    case "spotState":
    case "userFills":
    case "userTwapSliceFills":
      return `${message.channel}|${user(data.user)}|`;
    case "webData3":
      return `webData3|${user((data.userState as Record<string, unknown> | undefined)?.user)}|`;
    default:
      return null;
  }
}

/** What goes on the wire: the main dex is sent without `dex`. */
function wireSubscription(sub: HlSubscription): HlSubscription {
  if ("dex" in sub && !sub.dex) {
    const rest: Record<string, unknown> = { ...sub };
    delete rest.dex;
    return rest as HlSubscription;
  }
  return sub;
}

const browserClock: Clock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export class HyperliquidSocket {
  private readonly url: string;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly clock: Clock;
  private readonly pingIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly idleCloseMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly random: () => number;

  private socket: WebSocketLike | null = null;
  private opened = false;
  private statusValue: ConnectionStatus = "idle";
  private attempt = 0;
  private lastMessageAt = 0;
  private pingTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private idleTimer: unknown = null;
  private readonly subs = new Map<string, { sub: HlSubscription; listeners: Set<Listener> }>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private warnedErrors = 0;

  constructor(options: HyperliquidSocketOptions = {}) {
    this.url = options.url ?? HYPERLIQUID_WS_URL;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.clock = options.clock ?? browserClock;
    this.pingIntervalMs = options.pingIntervalMs ?? 20_000;
    this.staleAfterMs = options.staleAfterMs ?? 45_000;
    this.idleCloseMs = options.idleCloseMs ?? 10_000;
    this.backoffBaseMs = options.backoffBaseMs ?? 1_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 30_000;
    this.random = options.random ?? Math.random;
  }

  get status(): ConnectionStatus {
    return this.statusValue;
  }

  /** Number of distinct subscriptions currently held. */
  get subscriptionCount(): number {
    return this.subs.size;
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Adds a listener for `sub`'s messages (their `data`); returns the
   * function that removes it. */
  subscribe(sub: HlSubscription, listener: Listener): () => void {
    const key = subscriptionKey(sub);
    let entry = this.subs.get(key);
    if (!entry) {
      entry = { sub, listeners: new Set() };
      this.subs.set(key, entry);
      if (this.opened) this.send({ method: "subscribe", subscription: wireSubscription(sub) });
    }
    entry.listeners.add(listener);
    this.cancelIdleClose();
    this.connect();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.release(key, listener);
    };
  }

  private release(key: string, listener: Listener) {
    const entry = this.subs.get(key);
    if (!entry) return;
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0) return;
    this.subs.delete(key);
    if (this.opened) this.send({ method: "unsubscribe", subscription: wireSubscription(entry.sub) });
    if (this.subs.size === 0) this.scheduleIdleClose();
  }

  private setStatus(status: ConnectionStatus) {
    if (status === this.statusValue) return;
    this.statusValue = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private connect() {
    if (this.socket || this.reconnectTimer !== null || this.subs.size === 0) return;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    let socket: WebSocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.opened = true;
      this.lastMessageAt = this.clock.now();
      for (const { sub } of this.subs.values()) this.send({ method: "subscribe", subscription: wireSubscription(sub) });
      this.schedulePing();
      this.setStatus("open");
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = this.clock.now();
      // A connection that delivers data is healthy: the next drop starts
      // the backoff over.
      this.attempt = 0;
      this.dispatch(event.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.dropSocket();
      if (this.subs.size > 0) this.scheduleReconnect();
      else this.setStatus("idle");
    };
    socket.onerror = () => {
      // A close event follows; reconnecting is handled there.
    };
  }

  private dispatch(raw: unknown) {
    let message: { channel?: unknown; data?: unknown };
    try {
      message = JSON.parse(typeof raw === "string" ? raw : String(raw)) as typeof message;
    } catch {
      return;
    }
    if (message.channel === "error") {
      if (this.warnedErrors++ < 5) console.warn("Hyperliquid WS error:", message.data);
      return;
    }
    const key = messageKey(message);
    const entry = key === null ? undefined : this.subs.get(key);
    if (!entry) return;
    for (const listener of [...entry.listeners]) {
      try {
        listener(message.data);
      } catch (error) {
        console.error("Hyperliquid WS listener failed", error);
      }
    }
  }

  private send(payload: unknown) {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch {
      // The close handler reconnects.
    }
  }

  private schedulePing() {
    this.pingTimer = this.clock.setTimeout(() => {
      this.pingTimer = null;
      if (!this.socket || !this.opened) return;
      if (this.clock.now() - this.lastMessageAt > this.staleAfterMs) {
        // Silent too long: assume the connection is dead (a sleeping laptop,
        // a proxy dropping it without a close frame) and start over.
        const socket = this.socket;
        this.dropSocket();
        try {
          socket.close();
        } catch {
          // Already gone.
        }
        this.scheduleReconnect();
        return;
      }
      this.send({ method: "ping" });
      this.schedulePing();
    }, this.pingIntervalMs);
  }

  private dropSocket() {
    this.socket = null;
    this.opened = false;
    if (this.pingTimer !== null) {
      this.clock.clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Delay before reconnect attempt `n` (0-based): base × 2ⁿ, capped,
   * ±20% jitter. */
  backoffDelay(n: number): number {
    const raw = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** n);
    return Math.round(raw * (0.8 + 0.4 * this.random()));
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    this.setStatus("reconnecting");
    const delay = this.backoffDelay(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private scheduleIdleClose() {
    this.cancelIdleClose();
    this.idleTimer = this.clock.setTimeout(() => {
      this.idleTimer = null;
      if (this.subs.size > 0) return;
      this.close();
    }, this.idleCloseMs);
  }

  private cancelIdleClose() {
    if (this.idleTimer === null) return;
    this.clock.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Closes the connection now and stops reconnecting (subscriptions are
   * kept and resent if a later `subscribe` reconnects). */
  close() {
    if (this.reconnectTimer !== null) {
      this.clock.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.dropSocket();
    this.attempt = 0;
    try {
      socket?.close(1000, "idle");
    } catch {
      // Already closed.
    }
    this.setStatus("idle");
  }
}

let shared: HyperliquidSocket | null = null;

/** This tab's connection; null during server rendering (and wherever there
 * is no WebSocket). */
export function getHyperliquidSocket(): HyperliquidSocket | null {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return null;
  shared ??= new HyperliquidSocket();
  return shared;
}
