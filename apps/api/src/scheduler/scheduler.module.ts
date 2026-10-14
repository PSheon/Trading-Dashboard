import { Module } from "@nestjs/common";

import { WatcherModule } from "../watcher/watcher.module.js";
import { SchedulerRepository } from "./scheduler.repository.js";
import { SchedulerService } from "./scheduler.service.js";

/** Snapshots, sweeps and the backfill turn, on the `read` (or `all`) worker only.
 * WatcherModule gives capabilities without starting a feed. */
@Module({
  imports: [WatcherModule],
  providers: [SchedulerRepository, SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
