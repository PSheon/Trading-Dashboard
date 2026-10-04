import { Injectable, Module, type OnApplicationBootstrap } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { LeaderboardIngestService } from "./leaderboard-ingest.service.js";
import { AnalysisHistoryService } from "./analysis-history.service.js";
import { TradeAnalyticsService } from "./trade-analytics.service.js";
import { budgetConsumer, UNRANKED_BASE } from "../hyperliquid/request-budgeter.service.js";
import { TradersModule } from "./traders.module.js";

/** The leaderboard import (at startup and every minute) and the analysis
 * history job: the worker process only (AppModule.worker()). */
@Injectable()
export class TradersWorker implements OnApplicationBootstrap {
  constructor(private readonly ingest: LeaderboardIngestService, private readonly history: AnalysisHistoryService, private readonly analytics: TradeAnalyticsService) {}
  onApplicationBootstrap() { this.ingest.start(); }
  @Cron(CronExpression.EVERY_MINUTE) historyTick() {
    return budgetConsumer("history", async () => {
      const address = await this.history.tick();
      // Publish a completed archive through the existing serialized analytics path.
      if (address) await this.analytics.compute(address, false, { rank: UNRANKED_BASE, funding: false }).catch(() => undefined);
    });
  }
  @Cron(CronExpression.EVERY_MINUTE) ingestTick() { return this.ingest.onTick(); }
}
@Module({ imports: [TradersModule], providers: [TradersWorker] })
export class TradersWorkerModule {}
