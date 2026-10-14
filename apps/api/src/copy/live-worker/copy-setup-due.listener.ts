import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { AppConfig } from '../../config/app-config.js';
import { DATABASE_POOL } from '../../db/drizzle.provider.js';
import { BackgroundJobs } from '../../runtime/background-jobs.service.js';
import { ReconnectBackoff } from '../../runtime/reconnect-backoff.js';
import { safeErrorText } from '../../runtime/safe-error-text.js';
import { COPY_SETUP_DUE_CHANNEL } from '../copy-live-setup.repository.js';
import { CopyLiveSetupService } from '../copy-live-setup.service.js';

/** A setup id (a UUID); anything else on the channel is ignored. */
const SETUP_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * API_SETUP_DRIVE=worker: on `NOTIFY copy_setup_due, <id>` drive that setup at
 * once (CopyLiveSetupService.driveDue). LISTEN on a dedicated connection with
 * backoff (as runtime/action-relay.ts). A hint only: a lost wake-up is picked
 * up by the engine's setup pass; the setup's lease fences concurrent drives.
 * Live copy only; not under NODE_ENV=test.
 */
@Injectable()
export class CopySetupDueListener implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CopySetupDueListener.name);
  private client?: PoolClient;
  private retry?: ReturnType<typeof setTimeout>;
  private readonly backoff = new ReconnectBackoff();
  private stopped = false;
  private connecting?: Promise<void>;
  /** Setups being driven, and those woken again meanwhile (driven once more after). */
  private readonly driving = new Set<string>();
  private readonly again = new Set<string>();
  constructor(private readonly config: AppConfig, @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly setups: CopyLiveSetupService, private readonly jobs: BackgroundJobs) {}

  onApplicationBootstrap(): Promise<void> | void {
    if (this.config.value.app.nodeEnv === 'test' || !this.config.value.copy.live) return;
    return this.start();
  }
  /** Listens (tests call it directly). */
  start(): Promise<void> {
    this.connecting ??= this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async open(): Promise<void> {
    try {
      const client = await this.pool.connect();
      if (this.stopped) { client.release(true); return; }
      this.client = client;
      client.on('error', () => this.disconnected(client));
      client.on('end', () => this.disconnected(client));
      client.on('notification', message => {
        if (message.channel !== COPY_SETUP_DUE_CHANNEL || !message.payload || !SETUP_ID.test(message.payload)) return;
        void this.drive(message.payload);
      });
      await client.query(`LISTEN ${COPY_SETUP_DUE_CHANNEL}`);
      this.logger.log(this.backoff.connected() ? 'Setup wake-ups listening again' : 'Setup wake-ups listening');
    } catch {
      if (this.client) { const c = this.client; this.client = undefined; c.release(true); }
      this.reconnect();
    }
  }
  private disconnected(client: PoolClient): void {
    if (this.client !== client) return;
    this.client = undefined;
    client.release(true);
    this.reconnect();
  }
  private reconnect(): void {
    if (this.stopped || this.retry) return;
    const { delayMs, transition } = this.backoff.failed();
    if (transition) this.logger.warn('Setup wake-ups disconnected; the copy pass still drives due setups (retrying, backing off up to 30 s)');
    this.retry = setTimeout(() => { this.retry = undefined; void this.start(); }, delayMs);
    this.retry.unref();
  }
  private async drive(id: string): Promise<void> {
    if (this.stopped || this.jobs.stopping) return;
    if (this.driving.has(id)) { this.again.add(id); return; }
    this.driving.add(id);
    try { await this.jobs.run(() => this.setups.driveDue(id)); }
    catch (error) { this.logger.warn(`setup ${id} wake-up kept for the next pass: ${safeErrorText(error)}`); }
    finally {
      this.driving.delete(id);
      if (this.again.delete(id)) void this.drive(id);
    }
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true; clearTimeout(this.retry);
    await this.connecting;
    const client = this.client; this.client = undefined;
    client?.release(true);
  }
}
