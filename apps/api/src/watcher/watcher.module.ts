import { Module } from "@nestjs/common";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { BackfillService } from "./backfill.service.js";
import { WatcherService } from "./watcher.service.js";

@Module({
  imports: [HyperliquidModule],
  providers: [WatcherService, BackfillService],
  exports: [WatcherService, BackfillService],
})
export class WatcherModule {}
