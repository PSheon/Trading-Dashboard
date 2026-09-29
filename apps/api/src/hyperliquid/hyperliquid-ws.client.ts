import { Injectable, Logger } from "@nestjs/common";
import { WebSocket } from "ws";

import { env } from "../config/env.js";
import type {
  HlWsIncomingMessage,
  HlWsSubscribeMessage,
} from "./types.js";

export type HlWsMessageHandler = (message: HlWsIncomingMessage) => void;

/**
 * Thin wrapper around Hyperliquid's `wss://api.hyperliquid.xyz/ws`.
 *
 * This is a connection + subscribe-message shape only. Reconnect-with-
 * resubscribe (W1), dedupe-on-resume, and the request-weight budgeter (W6)
 * all belong to the Watcher implementation task, not this scaffold — see
 * the TODOs below for exactly where they plug in.
 */
@Injectable()
export class HyperliquidWsClient {
  private readonly logger = new Logger(HyperliquidWsClient.name);
  private socket: WebSocket | undefined;

  /**
   * Opens the WS connection. Left uncalled by anything in this scaffold —
   * the Watcher module owns the lifecycle once it's implemented.
   */
  connect(onMessage: HlWsMessageHandler): void {
    // TODO(W1): on close/error, reconnect with backoff and replay every
    // active subscription from the `leaders` table (subscriptions must not
    // depend on in-memory state — §8 可用性).
    const url = env.hyperliquidWsUrl();
    this.socket = new WebSocket(url);

    this.socket.on("open", () => {
      this.logger.log("Hyperliquid WS connected");
    });

    this.socket.on("message", (data) => {
      // TODO: parse `data` into HlWsIncomingMessage and dispatch by channel.
      try {
        const parsed = JSON.parse(data.toString()) as HlWsIncomingMessage;
        onMessage(parsed);
      } catch (error) {
        this.logger.error("Failed to parse Hyperliquid WS message", error as Error);
      }
    });

    this.socket.on("error", (error) => {
      this.logger.error("Hyperliquid WS error", error);
    });

    this.socket.on("close", () => {
      this.logger.warn("Hyperliquid WS closed");
    });
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  private send(message: HlWsSubscribeMessage): void {
    // TODO(W6): subscriptions themselves aren't weighted like info calls,
    // but bulk (re)subscribing 100 addresses at once should still be paced
    // to avoid a connection-level burst — budgeter plugs in here too.
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Hyperliquid WS is not connected");
    }
    this.socket.send(JSON.stringify(message));
  }

  /** Subscribe to real-time fills for one address (§4.2 W1). */
  subscribeUserFills(address: string): void {
    this.send({
      method: "subscribe",
      subscription: { type: "userFills", user: address },
    });
  }

  /** Subscribe to liquidation/account events for one address (§4.2 W5). */
  subscribeUserEvents(address: string): void {
    this.send({
      method: "subscribe",
      subscription: { type: "userEvents", user: address },
    });
  }
}
