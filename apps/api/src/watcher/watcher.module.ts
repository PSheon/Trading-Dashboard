import { Module } from "@nestjs/common";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { FeedActionsRepository } from "./feed-actions.repository.js";
import { FeedActionsService } from "./feed-actions.service.js";
import { IngestionModule } from "./ingestion.module.js";
import { TradeFeedService } from "./trade-feed.service.js";
import { WatcherRepository } from "./watcher.repository.js";
import { WatcherService } from "./watcher.service.js";

/**
 * The watcher's capabilities: the watch list, sweeps and copied catch-ups,
 * fill sync, account state, the fast path's pieces and the (unstarted) trade
 * feed. Importing it starts nothing: no feed, no timer. The `read` worker's
 * schedules use it as is; WatcherRuntimeModule (the `copy` or `all` worker)
 * starts the watcher and its feed.
 */
@Module({
  imports: [HyperliquidModule, IngestionModule],
  providers: [WatcherRepository, FeedActionsRepository, WatcherService, TradeFeedService, FeedActionsService],
  exports: [WatcherService, TradeFeedService, IngestionModule],
})
export class WatcherModule {}
