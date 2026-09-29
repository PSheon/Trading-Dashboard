import { Module } from "@nestjs/common";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { WatcherService } from "./watcher.service.js";

@Module({
  imports: [HyperliquidModule],
  providers: [WatcherService],
  exports: [WatcherService],
})
export class WatcherModule {}
