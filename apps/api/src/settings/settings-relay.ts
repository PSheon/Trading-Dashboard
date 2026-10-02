import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { DATABASE_POOL } from "../db/drizzle.provider.js";
import { SETTINGS_CHANNEL, SettingsService } from "./settings.service.js";

const RETRY_MS = 1000;

/**
 * Makes a settings save in one process visible in every other one at once
 * (review finding 16): `SettingsService.patch` sends a NOTIFY in its own
 * transaction, and each process (api and worker alike) holds one LISTEN
 * connection here and drops its cached snapshot when it arrives.
 *
 * The notification is a hint; the rows stay the source of truth. While the
 * listening connection is down a notification could be missed, so the
 * service is told and reads the database on every call until the
 * connection is back (and the cache is dropped once more on reconnect).
 * Without a pool (unit tests that hand the service a fake database) this
 * does nothing and the service keeps its plain 30 s cache.
 */
@Injectable()
export class SettingsRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SettingsRelay.name);
  private client?: PoolClient;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private connecting?: Promise<void>;

  constructor(private readonly settings: SettingsService, @Optional() @Inject(DATABASE_POOL) private readonly pool?: Pool) {}

  async onApplicationBootstrap() {
    if (this.pool) await this.connect();
  }

  /** Whether the LISTEN connection is up (monitoring and tests). */
  get listening(): boolean {
    return this.client !== undefined;
  }

  private connect(): Promise<void> {
    this.connecting ??= this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async open() {
    let client: PoolClient | undefined;
    try {
      client = await this.pool!.connect();
      if (this.stopped) { client.release(true); return; }
      const held = client;
      held.on("error", () => this.disconnected(held));
      held.on("end", () => this.disconnected(held));
      held.on("notification", (message) => {
        if (message.channel !== SETTINGS_CHANNEL || message.payload === this.settings.origin) return;
        this.settings.invalidate();
      });
      await held.query(`LISTEN ${SETTINGS_CHANNEL}`);
      this.client = held;
      // Anything saved while this process was not listening is picked up now.
      this.settings.setRelayConnected(true);
      this.logger.log("Settings relay listening");
    } catch {
      if (client && this.client !== client) client.release(true);
      this.settings.setRelayConnected(false);
      this.reconnect();
    }
  }

  private disconnected(client: PoolClient) {
    if (this.client !== client) return;
    this.client = undefined;
    client.release(true);
    this.settings.setRelayConnected(false);
    this.reconnect();
  }

  private reconnect() {
    if (this.stopped || this.retry) return;
    this.logger.warn("Settings relay disconnected; settings are read uncached until it is back");
    this.retry = setTimeout(() => { this.retry = undefined; void this.connect(); }, RETRY_MS);
    this.retry.unref();
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.retry);
    await this.connecting;
    const client = this.client;
    this.client = undefined;
    client?.release(true);
  }
}
