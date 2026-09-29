import { Injectable } from "@nestjs/common";

import { HyperliquidWsClient } from "../hyperliquid/hyperliquid-ws.client.js";

/**
 * Owns WS subscriptions for every active leader address (§4.2 W1–W3, W5).
 *
 * Empty-but-wired for M1: no subscribe-on-startup, no reconnect/resubscribe,
 * no fill dedupe-and-write, no 1s aggregation window into `actions`. That is
 * the next task's scope.
 */
@Injectable()
export class WatcherService {
  constructor(private readonly ws: HyperliquidWsClient) {}

  /** Connects WS and (re)subscribes every active address from `leaders`. */
  async start(): Promise<void> {
    throw new Error("not implemented");
  }

  async stop(): Promise<void> {
    throw new Error("not implemented");
  }

  /** Subscribes one newly-imported address (A2: within 60s of import). */
  async subscribeAddress(_address: string): Promise<void> {
    throw new Error("not implemented");
  }

  /** W2: dedupe by tid and persist a fill. */
  async handleIncomingFill(_rawFill: unknown): Promise<void> {
    throw new Error("not implemented");
  }

  /** W3: 1s aggregation window → one row in `actions`. */
  async flushActionWindow(_address: string, _coin: string): Promise<void> {
    throw new Error("not implemented");
  }
}
