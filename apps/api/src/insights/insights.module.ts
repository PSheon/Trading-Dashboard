import { Injectable, Module } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { DiscoveryModule } from "../discovery/discovery.module.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { budgetConsumer } from "../hyperliquid/request-budgeter.service.js";
import { CohortRepository } from "./cohort.repository.js";
import { CohortService } from "./cohort.service.js";
import { InsightsController } from "./insights.controller.js";
import { InsightsRepository } from "./insights.repository.js";
import { InsightsService } from "./insights.service.js";

/** Cross-trader views: the per-coin crowd (Stage 2 §10) and the PnL tier
 * cohorts (Stage 3 §3). Public. The cohort refresh's cron binding lives in
 * InsightsWorkerModule, so importing this starts no background work. */
@Module({
  imports: [HyperliquidModule, DiscoveryModule],
  controllers: [InsightsController],
  providers: [InsightsService, InsightsRepository, CohortRepository, CohortService],
  exports: [CohortService],
})
export class InsightsModule {}

@Injectable()
class CohortWorker {
  constructor(private readonly cohorts: CohortService) {}
  @Cron(CronExpression.EVERY_MINUTE) cohortTick() { return budgetConsumer("cohort", () => this.cohorts.onTick(), { queueMs: 2 * 60_000 }); }
}

/** The cohort refresh schedule (one tick a minute; none in tests). */
@Module({ imports: [InsightsModule], providers: [CohortWorker] })
export class InsightsWorkerModule {}
