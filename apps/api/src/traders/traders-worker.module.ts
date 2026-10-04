import { Injectable, Logger, Module, type OnApplicationBootstrap } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { LeaderboardIngestService } from "./leaderboard-ingest.service.js";
import { AnalysisHistoryService } from "./analysis-history.service.js";
import { TradeAnalyticsService } from "./trade-analytics.service.js";
import { budgetConsumer, UNRANKED_BASE } from "../hyperliquid/request-budgeter.service.js";
import { TradersModule } from "./traders.module.js";

/** The leaderboard import (at startup and every minute), the analysis
 * history job and the watched traders' analytics refresh: the worker
 * process only (AppModule.worker()). */
@Injectable()
export class TradersWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(TradersWorker.name);
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
  /** Watched traders' trade analytics, kept within STALE_MS of their fills
   * (nothing else refreshes them: a page read only serves the stored row). */
  @Cron(CronExpression.EVERY_MINUTE) trackedTick() {
    return budgetConsumer("tracked", () => this.analytics.refreshTracked(), { queueMs: 2 * 60_000 }).catch((error: Error) => this.logger.warn(`Tracked analytics turn failed: ${error.message}`));
  }
}
@Module({ imports: [TradersModule], providers: [TradersWorker] })
export class TradersWorkerModule {}
