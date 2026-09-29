import { TradersRepository } from "./traders.repository.js";
import { Module } from "@nestjs/common";

import { AnalyticsModule } from "../analytics/analytics.module.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { LeaderboardIngestService } from "./leaderboard-ingest.service.js";
import { TradersController } from "./traders.controller.js";
import { TradersService } from "./traders.service.js";

/** Discovery capabilities and HTTP routes; startup/cron belongs to TradersWorkerModule. */
@Module({
  imports: [HyperliquidModule, AnalyticsModule],
  controllers: [TradersController],
  providers: [TradersRepository, TradersService, LeaderboardIngestService],
  exports: [TradersService, LeaderboardIngestService],
})
export class TradersModule {}
