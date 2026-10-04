import { Injectable, Module, type OnApplicationBootstrap } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { RevenueRepository } from "./revenue.repository.js";
import { RevenueService } from "./revenue.service.js";

/** The revenue capability: snapshots and the admin report. Schedules nothing. */
@Module({ imports: [HyperliquidModule], providers: [RevenueRepository, RevenueService], exports: [RevenueService] })
export class RevenueModule {}

@Injectable()
export class RevenueWorker implements OnApplicationBootstrap {
  constructor(private readonly revenue: RevenueService) {}

  onApplicationBootstrap(): void {
    this.revenue.triggerSnapshot("startup");
  }

  /** Minute 7 of every hour, off the top of the hour where the watcher's
   * sweep queues its burst. */
  @Cron("0 7 * * * *", { name: "revenue-snapshot" })
  async hourlySnapshot(): Promise<void> {
    await this.revenue.snapshot();
  }
}

/** The startup and hourly revenue snapshots (the worker process only). */
@Module({ imports: [RevenueModule], providers: [RevenueWorker] })
export class RevenueWorkerModule {}
