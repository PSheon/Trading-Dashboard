import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import type { HyperliquidInfoClient } from "../src/hyperliquid/hyperliquid-info.client.js";
import type { HlWsTrade } from "../src/hyperliquid/types.js";
import { TradeFeedService } from "../src/watcher/trade-feed.service.js";

/** A local stand-in for wss://api.hyperliquid.xyz/ws. */
async function fakeHyperliquid() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const subscriptions: string[] = [];
  const sockets: WebSocket[] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { method: string; subscription?: { coin: string } };
      if (message.method === "subscribe") subscriptions.push(message.subscription!.coin);
    });
  });
  return { server, subscriptions, sockets, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const markets = (main: string[], xyz: string[]) =>
  ({
    perpDexs: vi.fn(async () => [null, { name: "xyz" }]),
    meta: vi.fn(async (dex?: string) => ({
      universe: (dex === "xyz" ? xyz : main).map((name) => ({ name, szDecimals: 1, maxLeverage: 10 })),
    })),
  }) as unknown as HyperliquidInfoClient;

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("TradeFeedService — against a local WebSocket server", () => {
  let feed: TradeFeedService | undefined;
  let server: WebSocketServer | undefined;

  afterEach(() => {
    feed?.stop();
    server?.close();
  });

  it("subscribes to every listed market on every dex and reports watched counterparties", async () => {
    const fake = await fakeHyperliquid();
    server = fake.server;
    process.env.HYPERLIQUID_WS_URL = fake.url;
    const seen: Array<[string, number]> = [];
    feed = new TradeFeedService(markets(["BTC", "ETH"], ["xyz:TSLA"]));
    feed.setWatched(["0xAbC"]);
    await feed.start({ onTrade: (a, t) => seen.push([a, t.tid]), onGap: () => {} });

    await until(() => fake.subscriptions.length === 3);
    expect(fake.subscriptions.sort()).toEqual(["BTC", "ETH", "xyz:TSLA"]);

    const now = Date.now();
    const trades: HlWsTrade[] = [
      { coin: "BTC", side: "B", px: "1", sz: "1", time: now, hash: "0x", tid: 7, users: ["0xabc", "0xother"] },
      { coin: "BTC", side: "B", px: "1", sz: "1", time: now, hash: "0x", tid: 8, users: ["0xnope", "0xother"] },
      // Replayed on subscribe: too old to mean "just traded".
      { coin: "BTC", side: "B", px: "1", sz: "1", time: now - 5 * 60_000, hash: "0x", tid: 9, users: ["0xabc", "0xother"] },
    ];
    fake.sockets[0].send(JSON.stringify({ channel: "trades", data: trades }));
    await until(() => seen.length === 1);
    expect(seen).toEqual([["0xabc", 7]]);
    expect(feed.status()).toMatchObject({ socketsOpen: 1, socketsTotal: 1, markets: 3, disconnectedSince: null });
  });

  it("reconnects after a drop, resubscribes, and reports the gap", async () => {
    const fake = await fakeHyperliquid();
    server = fake.server;
    process.env.HYPERLIQUID_WS_URL = fake.url;
    const gaps: number[] = [];
    feed = new TradeFeedService(markets(["BTC"], []));
    await feed.start({ onTrade: () => {}, onGap: (since) => gaps.push(since) });
    await until(() => fake.subscriptions.length === 1);

    const droppedAt = Date.now();
    fake.sockets[0].terminate();
    await until(() => feed!.status().disconnectedSince !== null);
    await until(() => fake.subscriptions.length === 2, 5000);
    await until(() => gaps.length === 1);

    expect(gaps[0]).toBeGreaterThanOrEqual(droppedAt - 50);
    expect(feed.status()).toMatchObject({ socketsOpen: 1, disconnectedSince: null });
  });

  it("spreads markets over sockets of at most 200 subscriptions", async () => {
    const fake = await fakeHyperliquid();
    server = fake.server;
    process.env.HYPERLIQUID_WS_URL = fake.url;
    const main = Array.from({ length: 250 }, (_, i) => `C${i}`);
    feed = new TradeFeedService(markets(main, ["xyz:A"]));
    await feed.start({ onTrade: () => {}, onGap: () => {} });
    await until(() => fake.subscriptions.length === 251);
    expect(fake.sockets).toHaveLength(2);
    expect(feed.status()).toMatchObject({ socketsTotal: 2, markets: 251 });
  });
});
