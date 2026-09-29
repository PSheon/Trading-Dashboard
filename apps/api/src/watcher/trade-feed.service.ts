import { AppConfig } from "../config/app-config.js";
import { Injectable, Logger } from "@nestjs/common";
import { WebSocket } from "ws";

import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import type { HlWsIncomingMessage, HlWsTrade } from "../hyperliquid/types.js";

/** Headroom under the documented 1000 subscriptions per IP, spread over a
 * few sockets so one slow socket doesn't stall every market. */
const MAX_SUBSCRIPTIONS_PER_SOCKET = 200;
const PING_INTERVAL_MS = 30_000;
/** No message at all (not even a pong) for this long → assume dead. */
const STALE_AFTER_MS = 90_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
/** Subscribing replays each market's recent trades, which in a quiet market
 * can be hours old. Only fresh trades mean "just traded"; anything older is
 * left to the sweeps, so a (re)connect never raises alerts on old trades. */
export const MAX_TRADE_AGE_MS = 60_000;

export interface TradeFeedHandlers {
  /** A watched address was one side of `trade`. */
  onTrade(address: string, trade: HlWsTrade): void;
  /** A socket was down from `since` until now; trades in between were lost. */
  onGap(since: number): void;
}

export interface TradeFeedStatus {
  socketsOpen: number;
  socketsTotal: number;
  markets: number;
  lastTradeAt: Date | null;
  /** Earliest time any socket went down and hasn't recovered, else null. */
  disconnectedSince: Date | null;
}

interface Shard {
  coins: string[];
  socket?: WebSocket;
  connectedOnce: boolean;
  downSince: number | null;
  attempt: number;
  lastMessageAt: number;
  pingTimer?: ReturnType<typeof setInterval>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Real-time fill discovery (W1) from the per-coin `trades` channel.
 *
 * User-specific subscriptions (`userFills`) are capped at 10 unique users
 * per IP, too few for 100 leaders. `trades` is per coin, not per user, and
 * every trade carries `users: [buyer, seller]`; subscribing to every perp
 * market (≈330 across all dexes on 2026-09-29) and filtering by address
 * sees every leader trade in about a second, whatever the number of leaders.
 *
 * A trade has no startPosition, closedPnl or fee: the caller derives the
 * position from its position book to alert at once, and stores the fill
 * itself from `userFillsByTime` afterwards.
 */
@Injectable()
export class TradeFeedService {
  private readonly logger = new Logger(TradeFeedService.name);
  private shards: Shard[] = [];
  private readonly subscribed = new Set<string>();
  private watched = new Set<string>();
  private handlers: TradeFeedHandlers | undefined;
  private lastTradeAt: Date | null = null;
  private stopped = true;

  constructor(private readonly config: AppConfig, private readonly info: HyperliquidInfoClient) {}

  async start(handlers: TradeFeedHandlers): Promise<void> {
    this.handlers = handlers;
    this.stopped = false;
    await this.refreshMarkets();
  }

  stop(): void {
    this.stopped = true;
    for (const shard of this.shards) {
      clearInterval(shard.pingTimer);
      clearTimeout(shard.reconnectTimer);
      shard.socket?.removeAllListeners();
      shard.socket?.terminate();
    }
    this.shards = [];
    this.subscribed.clear();
  }

  /** Addresses to report, compared lowercase. */
  setWatched(addresses: Iterable<string>): void {
    this.watched = new Set([...addresses].map((a) => a.toLowerCase()));
  }

  /** Every listed perp market on every dex. */
  async listMarkets(): Promise<string[]> {
    const dexes = (await this.info.perpDexs()).map((d) => d?.name ?? "");
    const coins: string[] = [];
    for (const dex of dexes) {
      const meta = await this.info.meta(dex || undefined);
      for (const asset of meta.universe) if (!asset.isDelisted) coins.push(asset.name);
    }
    return coins;
  }

  /** Subscribes to markets listed since the last call (new listings, new
   * dexes). Called at start and hourly. */
  async refreshMarkets(): Promise<void> {
    const coins = (await this.listMarkets()).filter((c) => !this.subscribed.has(c));
    if (this.stopped || coins.length === 0) return;
    for (const coin of coins) {
      let shard = this.shards.find((s) => s.coins.length < MAX_SUBSCRIPTIONS_PER_SOCKET);
      if (!shard) {
        shard = { coins: [], connectedOnce: false, downSince: null, attempt: 0, lastMessageAt: Date.now() };
        this.shards.push(shard);
      }
      shard.coins.push(coin);
      this.subscribed.add(coin);
      if (shard.socket?.readyState === WebSocket.OPEN) this.subscribe(shard, [coin]);
    }
    for (const shard of this.shards) if (!shard.socket) this.open(shard);
    this.logger.log(`Trade feed: ${this.subscribed.size} markets on ${this.shards.length} sockets`);
  }

  status(): TradeFeedStatus {
    const down = this.shards.map((s) => s.downSince).filter((t): t is number => t !== null);
    return {
      socketsOpen: this.shards.filter((s) => s.socket?.readyState === WebSocket.OPEN).length,
      socketsTotal: this.shards.length,
      markets: this.subscribed.size,
      lastTradeAt: this.lastTradeAt,
      disconnectedSince: down.length ? new Date(Math.min(...down)) : null,
    };
  }

  /** Parses one socket message. Public for tests. */
  handleMessage(text: string): void {
    let message: HlWsIncomingMessage;
    try {
      message = JSON.parse(text) as HlWsIncomingMessage;
    } catch {
      this.logger.warn(`Unparseable WS message: ${text.slice(0, 200)}`);
      return;
    }
    if (message.channel === "error") {
      this.logger.error(`Hyperliquid WS error: ${JSON.stringify(message.data)}`);
      return;
    }
    if (message.channel !== "trades" || !Array.isArray(message.data)) return;
    const oldest = Date.now() - MAX_TRADE_AGE_MS;
    for (const trade of message.data as HlWsTrade[]) {
      if (trade.time < oldest) continue;
      this.lastTradeAt = new Date();
      for (const user of trade.users ?? []) {
        const address = user.toLowerCase();
        if (this.watched.has(address)) this.handlers?.onTrade(address, trade);
      }
    }
  }

  private open(shard: Shard): void {
    const socket = new WebSocket(this.config.value.hyperliquid.wsUrl);
    shard.socket = socket;

    socket.on("open", () => {
      shard.attempt = 0;
      shard.lastMessageAt = Date.now();
      this.subscribe(shard, shard.coins);
      if (shard.connectedOnce && shard.downSince !== null) {
        this.logger.warn(`Trade feed socket back after ${Math.round((Date.now() - shard.downSince) / 1000)}s`);
        this.handlers?.onGap(shard.downSince);
      }
      shard.connectedOnce = true;
      shard.downSince = null;
      clearInterval(shard.pingTimer);
      shard.pingTimer = setInterval(() => {
        if (Date.now() - shard.lastMessageAt > STALE_AFTER_MS) {
          this.logger.warn("Trade feed socket silent for 90s, reconnecting");
          socket.terminate();
          return;
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ method: "ping" }));
      }, PING_INTERVAL_MS);
    });

    socket.on("message", (data) => {
      shard.lastMessageAt = Date.now();
      this.handleMessage(data.toString());
    });

    socket.on("error", (error) => {
      this.logger.error(`Trade feed socket error: ${error.message}`);
    });

    socket.on("close", () => {
      clearInterval(shard.pingTimer);
      if (this.stopped || shard.socket !== socket) return;
      shard.downSince ??= Date.now();
      const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** shard.attempt);
      shard.attempt += 1;
      shard.reconnectTimer = setTimeout(() => this.open(shard), delay);
    });
  }

  private subscribe(shard: Shard, coins: string[]): void {
    for (const coin of coins) {
      shard.socket?.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } }));
    }
  }
}
