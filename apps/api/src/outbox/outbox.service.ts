import { AppConfig } from "../config/app-config.js";
import { Injectable, Logger, Optional, type OnApplicationBootstrap } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { OutboxRepository } from "./outbox.repository.js";
import { RulesService } from "../rules/rules.service.js";
import { NotifyService } from "../notify/notify.service.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";

/** Recover interrupted action evaluation and drain durable notification deliveries. */
@Injectable()
export class OutboxService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxService.name);
  private running: Promise<void> | undefined;
  constructor(private readonly config: AppConfig, private readonly repository: OutboxRepository,
    private readonly rules: RulesService, private readonly notify: NotifyService,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs()) {}

  onApplicationBootstrap() { if (this.config.value.app.nodeEnv !== "test" && this.config.value.app.role !== "api") void this.drain(); }

  /** Coalesce local drains; repository claims coordinate competing processes. */
  @Interval(5000)
  async drain(): Promise<void> {
    if (this.jobs.stopping) return;
    this.running ??= this.jobs.run(() => this.process()).catch((error: unknown) => {
      this.logger.error(`Outbox drain failed: ${(error as Error).message}`);
    }).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async process(): Promise<void> {
    const now = new Date();
    const rows = await this.repository.findDue(now);
    for (const { id } of rows) {
      if (this.jobs.stopping) return;
      const claimed = await this.repository.claim(id, now, new Date(Date.now() + 300_000));
      if (!claimed) continue;
      try {
        if (claimed.attempts > 5) throw new Error("attempt limit");
        const action = await this.repository.findAction(id);
        if (action) await this.rules.evaluateAction(action);
      } catch {
        await this.repository.recordFailure(id, claimed.attempts >= 5 ? "failed" : "pending",
          new Date(Date.now() + 60_000), claimed.attempts);
      }
    }
    await this.notify.deliverAction();
  }
}
