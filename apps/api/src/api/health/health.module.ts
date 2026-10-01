import { Module } from "@nestjs/common";

import { ArchiveIngestModule } from "../../ingest/archive-ingest.module.js";
import { HyperliquidModule } from "../../hyperliquid/hyperliquid.module.js";
import { SchedulerModule } from "../../scheduler/scheduler.module.js";
import { WatcherModule } from "../../watcher/watcher.module.js";
import { ReadinessController } from "./readiness.controller.js";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";

@Module({
  imports: [HyperliquidModule, WatcherModule, SchedulerModule, ArchiveIngestModule],
  controllers: [HealthController, ReadinessController],
  providers: [HealthService],
})
export class HealthModule {}
