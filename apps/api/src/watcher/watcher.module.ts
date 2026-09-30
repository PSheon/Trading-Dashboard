import { BackfillJobsModule } from "../jobs/backfill-jobs.module.js";
import { BackfillWorker } from "../jobs/backfill-worker.service.js";
import { Module } from "@nestjs/common";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { FeedActionsRepository } from "./feed-actions.repository.js";
import { FeedActionsService } from "./feed-actions.service.js";
import { IngestionModule } from "./ingestion.module.js";
import { TradeFeedService } from "./trade-feed.service.js";
import { WatcherRepository } from "./watcher.repository.js";
import { WatcherService } from "./watcher.service.js";

/** Explicit worker orchestration; shared on-demand capabilities come from IngestionModule. */
@Module({
  imports: [BackfillJobsModule, HyperliquidModule, IngestionModule],
  providers: [BackfillWorker, WatcherRepository, FeedActionsRepository, WatcherService, TradeFeedService, FeedActionsService],
  exports: [WatcherService, TradeFeedService, IngestionModule],
})
export class WatcherModule {}
