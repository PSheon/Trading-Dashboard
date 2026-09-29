import { Module } from "@nestjs/common";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { AccountStateService } from "./account-state.service.js";
import { BackfillService } from "./backfill.service.js";
import { FeedActionsService } from "./feed-actions.service.js";
import { FillSyncService } from "./fill-sync.service.js";
import { TradeFeedService } from "./trade-feed.service.js";
import { WatcherService } from "./watcher.service.js";

@Module({
  imports: [HyperliquidModule],
  providers: [WatcherService, BackfillService, FillSyncService, AccountStateService, TradeFeedService, FeedActionsService],
  exports: [WatcherService, BackfillService, FillSyncService, AccountStateService, TradeFeedService, FeedActionsService],
})
export class WatcherModule {}
