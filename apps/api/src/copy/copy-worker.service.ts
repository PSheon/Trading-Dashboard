import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";

import { AppConfig } from "../config/app-config.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { CopyExecutionService } from "./copy-execution.service.js";
import { CopySignalService } from "./copy-signal.service.js";
import { COPY_SNAPSHOT_INTERVAL_MS, CopyPerformanceService } from "./copy-performance.service.js";

/** Consumer passes per tick before yielding (each pass ≤ SIGNAL_BATCH rows). */
const MAX_PASSES = 5;
const FUNDING_CHECK_MS = 60_000;

/**
 * Drives paper copy trading: every COPY_WORKER_INTERVAL_MS (default 2 s)
 * the signal consumer drains the execution outbox, the executor fills
 * approved orders, strategies below their maintenance margin are
 * liquidated, stopping strategies settle, and once a minute hourly
 * funding is checked. One tick at a time. Runs in the worker process only
 * (CopyWorkerModule); not started under NODE_ENV=test or COPY_TRADING_MODE=disabled. On restart the consumer resumes from its
 * checkpoint (pending outbox rows) and the executor from orders left
 * `risk_approved` or `submitting`.
 */
@Injectable()
export class CopyWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CopyWorkerService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private lastFundingCheck = 0;
  private lastSnapshotAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly signals: CopySignalService,
    private readonly execution: CopyExecutionService,
    private readonly jobs: BackgroundJobs,
    private readonly performance: CopyPerformanceService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.value.app.nodeEnv === "test" || this.config.value.copy.mode === "disabled") return;
    this.timer = setInterval(() => void this.tick(), this.config.value.copy.workerIntervalMs);
    this.timer.unref?.();
    this.logger.log(`Paper copy worker every ${this.config.value.copy.workerIntervalMs} ms`);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** One pass of every stage; overlapping ticks are skipped. */
  async tick(): Promise<void> {
    if (this.running || this.jobs.stopping) return;
    this.running = true;
    try {
      await this.jobs.run(async () => {
        for (let i = 0; i < MAX_PASSES; i++) {
          const r = await this.signals.drain();
          if (r.processed === 0) break;
        }
        await this.execution.drain();
        await this.execution.liquidate();
        await this.execution.settleStopping();
        if (Date.now() - this.lastFundingCheck > FUNDING_CHECK_MS) {
          this.lastFundingCheck = Date.now();
          await this.execution.accrueFunding();
        }
        if (Date.now() - this.lastSnapshotAt >= COPY_SNAPSHOT_INTERVAL_MS) {
          await this.performance.capture();
          this.lastSnapshotAt = Date.now();
        }
      });
    } catch (error) {
      this.logger.error(`Copy worker tick failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
