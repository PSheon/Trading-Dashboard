import { Module } from "@nestjs/common";

import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { AccountStateRepository } from "./account-state.repository.js";
import { AccountStateService } from "./account-state.service.js";
import { BackfillService } from "./backfill.service.js";
import { FillSyncRepository } from "./fill-sync.repository.js";
import { FillSyncService } from "./fill-sync.service.js";

/** On-demand ingestion capabilities; importing a feature does not start a watcher. */
@Module({
  imports: [HyperliquidModule],
  providers: [AccountStateRepository, AccountStateService, FillSyncRepository, FillSyncService, BackfillService],
  exports: [AccountStateService, FillSyncService, BackfillService],
})
export class IngestionModule {}
