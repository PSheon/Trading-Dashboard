import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { WatcherModule } from "../watcher/watcher.module.js";
import { SchedulerService } from "./scheduler.service.js";

@Module({
  imports: [ScheduleModule.forRoot(), HyperliquidModule, WatcherModule],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
