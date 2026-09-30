import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";

import { NotifyModule } from "../notify/notify.module.js";
import { WatcherModule } from "../watcher/watcher.module.js";
import { SchedulerRepository } from "./scheduler.repository.js";
import { SchedulerService } from "./scheduler.service.js";

@Module({
  imports: [ScheduleModule.forRoot(), WatcherModule, NotifyModule],
  providers: [SchedulerRepository, SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
