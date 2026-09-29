import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";

import { NotifyModule } from "../notify/notify.module.js";
import { WatcherModule } from "../watcher/watcher.module.js";
import { SchedulerService } from "./scheduler.service.js";

@Module({
  imports: [ScheduleModule.forRoot(), WatcherModule, NotifyModule],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
