import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { actionOutbox, actions } from "@trading-dashboard/shared";
import { and, eq, lte, or, sql } from "drizzle-orm";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { RulesService } from "../rules/rules.service.js";
import { NotifyService } from "../notify/notify.service.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";

@Injectable()
export class OutboxService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxService.name);
  private running: Promise<void> | undefined;
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly rules: RulesService, private readonly notify: NotifyService,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs()) {}

  onApplicationBootstrap() { if (process.env.NODE_ENV !== "test") void this.drain(); }

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
    const due = or(and(eq(actionOutbox.status, "pending"), lte(actionOutbox.availableAt, now)),
      and(eq(actionOutbox.status, "processing"), lte(actionOutbox.lockedUntil, now)));
    const rows = await this.db.select({ id: actionOutbox.actionId }).from(actionOutbox).where(due)
      .orderBy(actionOutbox.actionId).limit(20);
    for (const { id } of rows) {
      if (this.jobs.stopping) return;
      const [claimed] = await this.db.update(actionOutbox).set({ status: "processing",
        attempts: sql`${actionOutbox.attempts} + 1`, lockedUntil: new Date(Date.now() + 300_000),
      }).where(and(eq(actionOutbox.actionId, id), due)).returning();
      if (!claimed) continue;
      try {
        if (claimed.attempts > 5) throw new Error("attempt limit");
        const [action] = await this.db.select().from(actions).where(eq(actions.id, id));
        if (action) await this.rules.evaluateAction(action);
      } catch {
        await this.db.update(actionOutbox).set({ status: claimed.attempts >= 5 ? "failed" : "pending",
          lockedUntil: null, availableAt: new Date(Date.now() + 60_000), lastError: "evaluation failed",
        }).where(and(eq(actionOutbox.actionId, id), eq(actionOutbox.status, "processing")));
      }
    }
    await this.notify.deliverAction();
  }
}
