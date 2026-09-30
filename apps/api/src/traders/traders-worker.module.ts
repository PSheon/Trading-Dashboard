import { AppConfig } from "../config/app-config.js";
import { Injectable, Module, type OnApplicationBootstrap } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { LeaderboardIngestService } from "./leaderboard-ingest.service.js";
import { TradersService } from "./traders.service.js";
import { AnalysisHistoryService } from "./analysis-history.service.js";
import { TradeAnalyticsService } from "./trade-analytics.service.js";
import { UNRANKED_BASE } from "../hyperliquid/request-budgeter.service.js";
import { TradersModule } from "./traders.module.js";
@Injectable()
export class TradersWorker implements OnApplicationBootstrap {
  constructor(private readonly config: AppConfig, private readonly ingest: LeaderboardIngestService, private readonly traders: TradersService, private readonly history: AnalysisHistoryService, private readonly analytics: TradeAnalyticsService) {}
  onApplicationBootstrap() { if (this.config.value.app.role === "api") return; this.ingest.start(); if (this.config.value.app.role === "combined") this.traders.startWarming(); }
  @Cron(CronExpression.EVERY_MINUTE) async historyTick() {
    const address = await this.history.tick();
    // Publish a completed archive through the existing serialized analytics path.
    if (address) await this.analytics.compute(address, false, { rank: UNRANKED_BASE, funding: false }).catch(() => undefined);
  }
  @Cron(CronExpression.EVERY_MINUTE) ingestTick() { return this.ingest.onTick(); }
  @Cron("0 */10 * * * *") warmTick() { if (this.config.value.app.role === "combined") return this.traders.onWarmSchedule(); }
}
@Module({ imports: [TradersModule], providers: [TradersWorker] })
export class TradersWorkerModule {}
