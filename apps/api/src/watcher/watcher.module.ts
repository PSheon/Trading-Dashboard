import { Module } from "@nestjs/common";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { FeedActionsRepository } from "./feed-actions.repository.js";
import { FeedActionsService } from "./feed-actions.service.js";
import { IngestionModule } from "./ingestion.module.js";
import { TradeFeedService } from "./trade-feed.service.js";
import { WatcherRepository } from "./watcher.repository.js";
import { WatcherService } from "./watcher.service.js";

/**
 * The watcher's capabilities (watch list, sweeps, fill sync, account state,
 * fast path, unstarted feed). Importing it starts nothing;
 * WatcherRuntimeModule starts the watcher and feed.
 */
@Module({
  imports: [HyperliquidModule, IngestionModule],
  providers: [WatcherRepository, FeedActionsRepository, WatcherService, TradeFeedService, FeedActionsService],
  exports: [WatcherService, TradeFeedService, IngestionModule],
})
export class WatcherModule {}
