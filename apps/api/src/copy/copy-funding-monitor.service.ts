import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { AppConfig } from "../config/app-config.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { CopyFundingService } from "./copy-funding.service.js";

/** Receipt lookups only; never signs, retries, funds or activates a copy. */
@Injectable()
export class CopyFundingMonitor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CopyFundingMonitor.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  constructor(private readonly config: AppConfig, private readonly funding: CopyFundingService, private readonly jobs: BackgroundJobs) {}
  onApplicationBootstrap() {
    if (this.config.value.app.nodeEnv === "test" || this.config.value.app.role === "api") return;
    this.timer = setInterval(() => void this.tick(), 15_000); this.timer.unref?.();
  }
  onModuleDestroy() { clearInterval(this.timer); }
  async tick() {
    if (this.running || this.jobs.stopping) return;
    this.running = true;
    try { await this.jobs.run(() => this.funding.reconcilePending()); }
    catch { this.logger.warn("Strategy funding confirmation unavailable; pending records retained"); }
    finally { this.running = false; }
  }
}
