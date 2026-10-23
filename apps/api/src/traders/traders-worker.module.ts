import { Injectable, Logger, Module, type OnApplicationBootstrap } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { LeaderboardIngestService } from "./leaderboard-ingest.service.js";
import { AnalysisHistoryService } from "./analysis-history.service.js";
import { TradeAnalyticsService } from "./trade-analytics.service.js";
import { SuggestedBudgetRepository } from "./suggested-budget.repository.js";
import { budgetConsumer, UNRANKED_BASE } from "../hyperliquid/request-budgeter.service.js";
import { TradersModule } from "./traders.module.js";
import { safeErrorText } from "../runtime/safe-error-text.js";

/** The leaderboard import (at startup and every minute), the analysis
 * history job, the watched traders' analytics refresh and the leaders'
 * suggested minimum budgets (hourly, SQL only): the `read` worker only
 * (WorkerModule READ_MODULES). */
@Injectable()
export class TradersWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(TradersWorker.name);
  constructor(private readonly ingest: LeaderboardIngestService, private readonly history: AnalysisHistoryService, private readonly analytics: TradeAnalyticsService,
    private readonly suggested: SuggestedBudgetRepository) {}
  onApplicationBootstrap() { this.ingest.start(); void this.suggestedBudgetTick(); }
  /** Decision D7 (2026-10-23): every leader's suggested minimum budget, from stored fills and equity (no Hyperliquid call). */
  @Cron(CronExpression.EVERY_HOUR) async suggestedBudgetTick() {
    try { const { leaders, suggested } = await this.suggested.refresh(); this.logger.log(`Suggested budgets: ${leaders} leaders, ${suggested} with a suggestion`); }
    catch (error) { this.logger.warn(`Suggested budgets failed: ${safeErrorText(error)}`); }
  }
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
    return budgetConsumer("tracked", () => this.analytics.refreshTracked(), { queueMs: 2 * 60_000 }).catch((error: Error) => this.logger.warn(`Tracked analytics turn failed: ${safeErrorText(error)}`));
  }
}
@Module({ imports: [TradersModule], providers: [TradersWorker] })
export class TradersWorkerModule {}
