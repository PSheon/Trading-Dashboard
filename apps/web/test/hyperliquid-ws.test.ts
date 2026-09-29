import { describe, expect, it, vi } from "vitest";

import {
  HyperliquidSocket,
  messageKey,
  subscriptionKey,
  type Clock,
  type WebSocketLike,
} from "../src/lib/hyperliquid-ws";

/** A socket the test drives: records what the client sends. */
class FakeSocket implements WebSocketLike {
  sent: unknown[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop() {
    this.onclose?.({});
  }
  methods() {
    return this.sent.map((m) => (m as { method: string }).method);
  }
}

/** Manual clock: timers run only when the test advances time. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock & { advance(ms: number): void; pending(): number } = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
  return clock;
}

function setup() {
  const sockets: FakeSocket[] = [];
  const clock = fakeClock();
  const client = new HyperliquidSocket({
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    clock,
    pingIntervalMs: 20_000,
    staleAfterMs: 45_000,
    idleCloseMs: 10_000,
    backoffBaseMs: 1_000,
    backoffMaxMs: 30_000,
    random: () => 0.5, // no jitter
  });
  return { client, sockets, clock, last: () => sockets[sockets.length - 1] };
}

const USER = "0xAbC0000000000000000000000000000000000001";
const user = USER.toLowerCase();

describe("HyperliquidSocket", () => {
  it("connects lazily, sends subscriptions on open and routes messages to listeners", () => {
    const { client, sockets, last } = setup();
    expect(sockets).toHaveLength(0);
    const fills = vi.fn();
    const main = vi.fn();
    const xyz = vi.fn();
    client.subscribe({ type: "userFills", user: USER }, fills);
    client.subscribe({ type: "clearinghouseState", user: USER, dex: "" }, main);
    client.subscribe({ type: "clearinghouseState", user: USER, dex: "xyz" }, xyz);
    expect(sockets).toHaveLength(1);
    expect(client.status).toBe("connecting");
    expect(last().sent).toEqual([]); // nothing before open

    last().open();
    expect(client.status).toBe("open");
    expect(last().sent).toEqual([
      { method: "subscribe", subscription: { type: "userFills", user: USER } },
      // The main dex goes without `dex`.
      { method: "subscribe", subscription: { type: "clearinghouseState", user: USER } },
      { method: "subscribe", subscription: { type: "clearinghouseState", user: USER, dex: "xyz" } },
    ]);

    last().receive({ channel: "subscriptionResponse", data: {} });
    last().receive({ channel: "clearinghouseState", data: { dex: "xyz", user, clearinghouseState: { n: 1 } } });
    last().receive({ channel: "clearinghouseState", data: { dex: "", user, clearinghouseState: { n: 2 } } });
    last().receive({ channel: "userFills", data: { user, fills: [] } });
    last().receive({ channel: "userFills", data: { user: "0xsomeoneelse", fills: [] } });
    expect(xyz).toHaveBeenCalledWith({ dex: "xyz", user, clearinghouseState: { n: 1 } });
    expect(main).toHaveBeenCalledTimes(1);
    expect(fills).toHaveBeenCalledTimes(1);
  });

  it("reference-counts: one wire subscription per distinct subscription, unsubscribed with its last listener", () => {
    const { client, last } = setup();
    const a = vi.fn();
    const b = vi.fn();
    const offA = client.subscribe({ type: "allMids" }, a);
    last().open();
    const offB = client.subscribe({ type: "allMids", dex: "" }, b); // same subscription
    expect(last().methods()).toEqual(["subscribe"]);
    last().receive({ channel: "allMids", data: { mids: { BTC: "1" } } });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA();
    offA(); // idempotent
    expect(last().methods()).toEqual(["subscribe"]);
    offB();
    expect(last().sent.at(-1)).toEqual({ method: "unsubscribe", subscription: { type: "allMids" } });
    expect(client.subscriptionCount).toBe(0);
  });

  it("closes the socket a while after the last subscription leaves, unless one comes back", () => {
    const { client, sockets, clock, last } = setup();
    const off = client.subscribe({ type: "allMids" }, vi.fn());
    last().open();
    off();
    clock.advance(5_000);
    const off2 = client.subscribe({ type: "allMids" }, vi.fn()); // back within the idle delay
    clock.advance(20_000);
    expect(last().closed).toBe(false);
    off2();
    clock.advance(10_000);
    expect(last().closed).toBe(true);
    expect(client.status).toBe("idle");
    expect(sockets).toHaveLength(1); // no reconnect after an intentional close
  });

  it("reconnects with exponential backoff and resubscribes everything", () => {
    const { client, sockets, clock, last } = setup();
    const statuses: string[] = [];
    client.onStatus((s) => statuses.push(s));
    client.subscribe({ type: "webData3", user: USER }, vi.fn());
    client.subscribe({ type: "allMids", dex: "xyz" }, vi.fn());
    last().open();
    last().receive({ channel: "pong" });

    last().drop();
    expect(client.status).toBe("reconnecting");
    clock.advance(999);
    expect(sockets).toHaveLength(1);
    clock.advance(1); // 1 s
    expect(sockets).toHaveLength(2);

    last().drop(); // failed before opening: 2 s next
    clock.advance(1_999);
    expect(sockets).toHaveLength(2);
    clock.advance(1);
    expect(sockets).toHaveLength(3);
    last().drop(); // then 4 s
    clock.advance(4_000);
    expect(sockets).toHaveLength(4);

    // A subscription added while down goes out with the rest on open.
    client.subscribe({ type: "spotState", user: USER }, vi.fn());
    last().open();
    expect(last().sent).toEqual([
      { method: "subscribe", subscription: { type: "webData3", user: USER } },
      { method: "subscribe", subscription: { type: "allMids", dex: "xyz" } },
      { method: "subscribe", subscription: { type: "spotState", user: USER } },
    ]);
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "open"]);

    // Data on the new connection resets the backoff.
    last().receive({ channel: "pong" });
    last().drop();
    clock.advance(1_000);
    expect(sockets).toHaveLength(5);
  });

  it("caps the backoff and spreads it ±20%", () => {
    const low = new HyperliquidSocket({ random: () => 0, backoffBaseMs: 1_000, backoffMaxMs: 30_000 });
    const high = new HyperliquidSocket({ random: () => 1, backoffBaseMs: 1_000, backoffMaxMs: 30_000 });
    expect([0, 1, 2, 3, 4, 5, 10].map((n) => low.backoffDelay(n))).toEqual([800, 1600, 3200, 6400, 12800, 24000, 24000]);
    expect(high.backoffDelay(10)).toBe(36_000);
  });

  it("pings on an interval and drops a connection that has gone silent", () => {
    const { client, sockets, clock, last } = setup();
    client.subscribe({ type: "allMids" }, vi.fn());
    last().open();
    clock.advance(20_000);
    expect(last().sent.at(-1)).toEqual({ method: "ping" });
    last().receive({ channel: "pong" });
    clock.advance(20_000);
    expect(last().methods().filter((m) => m === "ping")).toHaveLength(2);

    // No pong or data for > 45 s: close and reconnect.
    clock.advance(40_000);
    expect(sockets[0].closed).toBe(true);
    expect(client.status).toBe("reconnecting");
    clock.advance(1_000);
    expect(sockets).toHaveLength(2);
  });

  it("ignores events from a socket it has already replaced", () => {
    const { client, sockets, clock, last } = setup();
    const listener = vi.fn();
    client.subscribe({ type: "allMids" }, listener);
    last().open();
    const old = last();
    old.drop();
    clock.advance(1_000);
    old.receive({ channel: "allMids", data: { mids: {} } });
    old.drop();
    expect(listener).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(2);
  });

  it("keys subscriptions and messages the same way", () => {
    expect(subscriptionKey({ type: "clearinghouseState", user: USER })).toBe(`clearinghouseState|${user}|`);
    expect(messageKey({ channel: "clearinghouseState", data: { user, dex: "" } })).toBe(`clearinghouseState|${user}|`);
    expect(subscriptionKey({ type: "allMids", dex: "xyz" })).toBe(messageKey({ channel: "allMids", data: { dex: "xyz", mids: {} } }));
    expect(subscriptionKey({ type: "allMids" })).toBe(messageKey({ channel: "allMids", data: { mids: {} } }));
    expect(subscriptionKey({ type: "webData3", user: USER })).toBe(
      messageKey({ channel: "webData3", data: { userState: { user } } }),
    );
    expect(subscriptionKey({ type: "userTwapSliceFills", user: USER })).toBe(
      messageKey({ channel: "userTwapSliceFills", data: { user, twapSliceFills: [] } }),
    );
    expect(messageKey({ channel: "pong" })).toBeNull();
    expect(messageKey({ channel: "subscriptionResponse", data: {} })).toBeNull();
  });
});
