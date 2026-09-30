import { Module } from "@nestjs/common";

import { TradersRepository } from "./traders.repository.js";
import { LeaderboardIngestRepository } from "./leaderboard-ingest.repository.js";
import { AnalyticsModule } from "../analytics/analytics.module.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { KolAvatarModule } from "../discovery/kol-avatar.module.js";
import { LeaderboardIngestService } from "./leaderboard-ingest.service.js";
import { TradersController } from "./traders.controller.js";
import { SpotPriceService } from "./spot-price.service.js";
import { TradersService } from "./traders.service.js";
import { TradeAnalyticsController } from "./trade-analytics.controller.js";
import { TradeAnalyticsRepository } from "./trade-analytics.repository.js";
import { TradeAnalyticsService } from "./trade-analytics.service.js";

/** Discovery capabilities and HTTP routes; startup/cron belongs to TradersWorkerModule. */
@Module({
  imports: [HyperliquidModule, AnalyticsModule, KolAvatarModule],
  controllers: [TradersController, TradeAnalyticsController],
  providers: [LeaderboardIngestRepository, TradersRepository, TradersService, LeaderboardIngestService, SpotPriceService, TradeAnalyticsRepository, TradeAnalyticsService],
  exports: [TradersService, LeaderboardIngestService, TradeAnalyticsService],
})
export class TradersModule {}
