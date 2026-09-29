import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { SchedulerService } from "./scheduler.service.js";

@Module({
  imports: [ScheduleModule.forRoot(), HyperliquidModule],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
