import { Module } from "@nestjs/common";

import { AnalyticsModule } from "../analytics/analytics.module.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { LeaderboardIngestService } from "./leaderboard-ingest.service.js";
import { TradersController } from "./traders.controller.js";
import { TradersService } from "./traders.service.js";

/** Discovery of every Hyperliquid trader (Stage 2 §4): leaderboard ingest
 * into `trader_stats` and the public `/traders` routes. The ingest's @Cron
 * is picked up by the app-wide ScheduleModule (registered once in
 * SchedulerModule). */
@Module({
  imports: [HyperliquidModule, AnalyticsModule],
  controllers: [TradersController],
  providers: [TradersService, LeaderboardIngestService],
  exports: [TradersService, LeaderboardIngestService],
})
export class TradersModule {}
