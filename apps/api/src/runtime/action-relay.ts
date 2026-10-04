import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { DATABASE_POOL } from "../db/drizzle.provider.js";
import { ACTION_CREATED_EVENT, ACTION_CORRECTED_EVENT, type ActionCreatedEvent, type ActionCorrectedEvent } from "../watcher/action-created.event.js";

const CHANNEL = "orbie_actions";
export interface RemoteActions { created: string[]; updated: string[] }

/** Notifications are hints. Rows/outboxes in PG remain the durable source;
 * reconnect closes streams, forcing normal replay/refetch on the browser.
 * Every process publishes the actions it stores; only the api listens
 * (ActionRelayListener), to push them to its open action streams. */
@Injectable()
export class ActionRelay implements OnModuleDestroy {
  private readonly logger = new Logger(ActionRelay.name);
  private readonly origin = randomUUID();
  private client?: PoolClient;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private connecting?: Promise<void>;
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool, private readonly events: EventEmitter2) {}

  protected connect(): Promise<void> {
    this.connecting ??= this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async open() {
    try {
      const client = await this.pool.connect();
      if (this.stopped) { client.release(true); return; }
      this.client = client;
      client.on("error", () => this.disconnected(client));
      client.on("end", () => this.disconnected(client));
      client.on("notification", msg => {
        if (msg.channel !== CHANNEL || !msg.payload) return;
        try {
          const data = JSON.parse(msg.payload);
          if (data.origin === this.origin) return;
          if (![data.created, data.updated].every(ids => Array.isArray(ids) && ids.length <= 100 && ids.every(id => typeof id === "string" && /^[1-9]\d{0,18}$/.test(id)))) return;
          this.events.emit("action.remote", { created: data.created, updated: data.updated });
        } catch { /* Unrecognized payloads cannot reach stream subscribers. */ }
      });
      await client.query(`LISTEN ${CHANNEL}`);
      this.logger.log("Action relay listening");
    } catch {
      if (this.client) { const c = this.client; this.client = undefined; c.release(true); }
      this.reconnect();
    }
  }
  private disconnected(client: PoolClient) {
    if (this.client !== client) return;
    this.client = undefined;
    client.release(true);
    this.events.emit("action.relay-disconnected");
    this.reconnect();
  }
  private reconnect() {
    if (this.stopped || this.retry) return;
    this.logger.warn("Action relay disconnected; retrying");
    this.retry = setTimeout(() => { this.retry = undefined; void this.connect(); }, 1000);
    this.retry.unref();
  }
  @OnEvent(ACTION_CREATED_EVENT)
  publishCreated(row: ActionCreatedEvent) { return this.publish({ created: [String(row.id)], updated: [] }); }
  @OnEvent(ACTION_CORRECTED_EVENT)
  publishCorrected(event: ActionCorrectedEvent) {
    return this.publish({ created: event.inserted.map(r => String(r.id)), updated: event.updated.map(r => String(r.id)) });
  }
  private async publish(data: RemoteActions) {
    if (this.stopped) return;
    try {
      // Bound payloads below PostgreSQL's NOTIFY limit even on large corrections.
      for (let i = 0; i < Math.max(data.created.length, data.updated.length); i += 100) {
        await this.pool.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify({ origin: this.origin, created: data.created.slice(i, i + 100), updated: data.updated.slice(i, i + 100) })]);
      }
    } catch { this.logger.warn("Action relay publish failed; clients recover by polling/replay"); }
  }
  async onModuleDestroy() {
    this.stopped = true; clearTimeout(this.retry);
    await this.connecting;
    const client = this.client; this.client = undefined;
    client?.release(true);
  }
}

/** The api's side: listens for the worker's (and other replicas') actions. */
@Injectable()
export class ActionRelayListener extends ActionRelay implements OnApplicationBootstrap {
  async onApplicationBootstrap() { await this.connect(); }
}
