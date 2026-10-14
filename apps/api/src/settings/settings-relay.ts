import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { DATABASE_POOL } from "../db/drizzle.provider.js";
import { SETTINGS_CHANNEL, SettingsService } from "./settings.service.js";
import { SETTINGS_RELAY_RETRY_MS } from '../config/constants/background.js';


/**
 * One LISTEN connection per process that drops the settings cache on another process's
 * save (review 16). The NOTIFY is a hint; rows stay the truth. While disconnected the
 * service reads the DB on every call. Without a pool (unit tests) it does nothing.
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
    this.retry = setTimeout(() => { this.retry = undefined; void this.connect(); }, SETTINGS_RELAY_RETRY_MS);
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
