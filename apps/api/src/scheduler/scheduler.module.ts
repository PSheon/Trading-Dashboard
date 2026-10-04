import { Module } from "@nestjs/common";

import { NotifyModule } from "../notify/notify.module.js";
import { WatcherModule } from "../watcher/watcher.module.js";
import { SchedulerRepository } from "./scheduler.repository.js";
import { SchedulerService } from "./scheduler.service.js";

/** Snapshots, sweeps, the backfill turn and the feed self-alert: the worker
 * process only (its ScheduleModule fires the `@Cron` methods). */
@Module({
  imports: [WatcherModule, NotifyModule],
  providers: [SchedulerRepository, SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
