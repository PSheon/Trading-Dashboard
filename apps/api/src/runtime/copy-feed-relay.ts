import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { Pool, PoolClient } from "pg";

import { COPY_EVENTS_CHANNEL } from "../copy/copy-runtime.repository.js";
import { DATABASE_POOL } from "../db/drizzle.provider.js";

export const COPY_FEED_EVENT = "copy.feed";
export const COPY_FEED_DISCONNECTED_EVENT = "copy.feed-disconnected";
export interface CopyFeedEvent { userId: number }

/**
 * The api's ear for committed owner events (`insertOwnerEvent` NOTIFYs on
 * commit, from the worker or any api replica). A notification is only a
 * hint carrying the owner's id: the copy streams read the rows themselves,
 * owner-scoped. When the listening connection drops, every copy stream is
 * closed so its browser reconnects and replays from its last event id.
 */
@Injectable()
export class CopyFeedListener implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CopyFeedListener.name);
  private client?: PoolClient;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private connecting?: Promise<void>;
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool, private readonly events: EventEmitter2) {}

  async onApplicationBootstrap(): Promise<void> { await this.connect(); }

  private connect(): Promise<void> {
    this.connecting ??= this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async open(): Promise<void> {
    try {
      const client = await this.pool.connect();
      if (this.stopped) { client.release(true); return; }
      this.client = client;
      client.on("error", () => this.disconnected(client));
      client.on("end", () => this.disconnected(client));
      client.on("notification", (msg) => {
        if (msg.channel !== COPY_EVENTS_CHANNEL || !msg.payload || !/^[1-9]\d{0,9}$/.test(msg.payload)) return;
        this.events.emit(COPY_FEED_EVENT, { userId: Number(msg.payload) } satisfies CopyFeedEvent);
      });
      await client.query(`LISTEN ${COPY_EVENTS_CHANNEL}`);
      this.logger.log("Copy feed listening");
    } catch {
      if (this.client) { const c = this.client; this.client = undefined; c.release(true); }
      this.reconnect();
    }
  }

  private disconnected(client: PoolClient): void {
    if (this.client !== client) return;
    this.client = undefined;
    client.release(true);
    this.events.emit(COPY_FEED_DISCONNECTED_EVENT);
    this.reconnect();
  }

  private reconnect(): void {
    if (this.stopped || this.retry) return;
    this.logger.warn("Copy feed disconnected; retrying");
    this.retry = setTimeout(() => { this.retry = undefined; void this.connect(); }, 1000);
    this.retry.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    await this.connecting;
    const client = this.client;
    this.client = undefined;
    client?.release(true);
  }
}
