import { Module } from "@nestjs/common";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { IngestionModule } from "./ingestion.module.js";
import { FeedActionsService } from "./feed-actions.service.js";
import { TradeFeedService } from "./trade-feed.service.js";
import { WatcherService } from "./watcher.service.js";
/** Explicit worker orchestration, shared on-demand capabilities come from IngestionModule. */
@Module({ imports: [HyperliquidModule, IngestionModule],
  providers: [WatcherService, TradeFeedService, FeedActionsService],
  exports: [WatcherService, TradeFeedService, IngestionModule] })
export class WatcherModule {}
