import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.js';
import { BackgroundJobs } from '../../runtime/background-jobs.service.js';
import type { CopyLiveEngine } from './copy-live-engine.js';
import { LIVE_ENGINE } from './copy-live-engine.provider.js';

/**
 * Drives testnet copy execution in the worker process: one engine pass every
 * COPY_LIVE_INTERVAL_MS (default 3 s), never two at once. Off unless
 * COPY_TRADING_MODE=testnet, and under NODE_ENV=test. Paper copies keep their
 * own loop (CopyWorkerService). Shutdown drains the pass in flight.
 */
@Injectable()
export class CopyLiveWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CopyLiveWorkerService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  constructor(private readonly config: AppConfig, private readonly jobs: BackgroundJobs, @Inject(LIVE_ENGINE) private readonly engine: CopyLiveEngine | null) {}
  onApplicationBootstrap(): void {
    const live = this.config.value.copy.live;
    if (this.config.value.app.nodeEnv === 'test' || !this.engine || !live) return;
    this.timer = setInterval(() => void this.tick(), live.intervalMs);
    this.timer.unref?.();
    this.logger.log(`Testnet copy execution every ${live.intervalMs} ms`);
  }
  onModuleDestroy(): void { clearInterval(this.timer); }
  async tick(): Promise<void> {
    if (this.running || this.jobs.stopping || !this.engine) return;
    this.running = true;
    try { await this.jobs.run(() => this.engine!.tick()); }
    catch (error) { this.logger.error(`Testnet copy pass failed: ${error instanceof Error ? error.message : 'unknown'}`); }
    finally { this.running = false; }
  }
}
