import { Module } from "@nestjs/common";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { AccountStateService } from "./account-state.service.js";
import { BackfillService } from "./backfill.service.js";
import { FillSyncService } from "./fill-sync.service.js";
/** On-demand ingestion capabilities; importing a feature does not start a watcher. */
@Module({ imports: [HyperliquidModule], providers: [AccountStateService, FillSyncService, BackfillService],
  exports: [AccountStateService, FillSyncService, BackfillService] })
export class IngestionModule {}
