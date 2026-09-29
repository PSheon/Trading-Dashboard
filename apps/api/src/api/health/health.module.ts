import { Module } from "@nestjs/common";

import { HyperliquidModule } from "../../hyperliquid/hyperliquid.module.js";
import { WatcherModule } from "../../watcher/watcher.module.js";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";

@Module({
  imports: [HyperliquidModule, WatcherModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
