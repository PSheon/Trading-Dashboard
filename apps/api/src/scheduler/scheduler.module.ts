import { Module } from "@nestjs/common";

import { WatcherModule } from "../watcher/watcher.module.js";
import { SchedulerRepository } from "./scheduler.repository.js";
import { SchedulerService } from "./scheduler.service.js";

/** Snapshots, sweeps and the backfill turn: the `read` (or `all`) worker
 * only (its ScheduleModule fires the `@Cron` methods). WatcherModule gives
 * the capabilities (the watch list, sweeps, fill sync, account state) and
 * starts no feed; the feed's own self-alert is WatcherRuntimeModule's. */
@Module({
  imports: [WatcherModule],
  providers: [SchedulerRepository, SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
