import { Module } from "@nestjs/common";

import { RevenueWorkerModule } from "../admin/revenue.module.js";
import { CopyWorkerModule } from "../copy/copy-worker.module.js";
import { DiscoveryModule, DiscoveryWorkerModule } from "../discovery/discovery.module.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { ArchiveIngestModule, ArchiveIngestWorkerModule } from "../ingest/archive-ingest.module.js";
import { InsightsWorkerModule } from "../insights/insights.module.js";
import { OutboxWorkerModule } from "../outbox/outbox.module.js";
import { RetentionWorkerModule } from "../retention/retention.module.js";
import { RulesSeedModule } from "../rules/rules.module.js";
import { ActionRelay } from "../runtime/action-relay.js";
import { SchedulerModule } from "../scheduler/scheduler.module.js";
import { TelegramWorkerModule } from "../telegram/telegram.module.js";
import { TradersWorkerModule } from "../traders/traders-worker.module.js";
import { WatcherModule } from "../watcher/watcher.module.js";
import { WorkerHeartbeatService } from "./worker-heartbeat.service.js";

/**
 * Everything that runs on its own: the trade feed and watcher, the backfill
 * queue, snapshots and sweeps, the leaderboard import, the discovery pool,
 * cohorts, the archive ingest, retention, the outbox drain, the Telegram
 * bot, the default rules' seed, the copy loops and the revenue snapshot.
 * Only `AppModule.worker()` imports it; the api process constructs none of
 * these and has no ScheduleModule, so no `@Cron` / `@Interval` fires there.
 */
@Module({
  imports: [
    HyperliquidModule,
    WatcherModule,
    SchedulerModule,
    TradersWorkerModule,
    DiscoveryModule,
    DiscoveryWorkerModule,
    InsightsWorkerModule,
    ArchiveIngestModule,
    ArchiveIngestWorkerModule,
    RetentionWorkerModule,
    OutboxWorkerModule,
    TelegramWorkerModule,
    RulesSeedModule,
    CopyWorkerModule,
    RevenueWorkerModule,
  ],
  providers: [WorkerHeartbeatService, ActionRelay],
  exports: [WorkerHeartbeatService],
})
export class WorkerModule {}
