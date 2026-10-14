import { type DynamicModule, Module } from "@nestjs/common";

import { RevenueWorkerModule } from "../admin/revenue.module.js";
import { CopyLiveWorkerModule, CopyReportingWorkerModule } from "../copy/copy-worker.module.js";
import { DiscoveryModule, DiscoveryWorkerModule } from "../discovery/discovery.module.js";
import { HyperliquidModule } from "../hyperliquid/hyperliquid.module.js";
import { ArchiveIngestModule, ArchiveIngestWorkerModule } from "../ingest/archive-ingest.module.js";
import { InsightsWorkerModule } from "../insights/insights.module.js";
import { BackfillWorkerModule } from "../jobs/backfill-worker.module.js";
import { OutboxWorkerModule } from "../outbox/outbox.module.js";
import { RetentionWorkerModule } from "../retention/retention.module.js";
import { RulesModule, RulesSeedModule } from "../rules/rules.module.js";
import { ActionRelay } from "../runtime/action-relay.js";
import type { WorkerRole } from "../runtime/worker-role.js";
import { SchedulerModule } from "../scheduler/scheduler.module.js";
import { TelegramWorkerModule } from "../telegram/telegram.module.js";
import { TradersWorkerModule } from "../traders/traders-worker.module.js";
import { WatcherModule } from "../watcher/watcher.module.js";
import { WatcherRuntimeModule } from "../watcher/watcher-runtime.module.js";
import { WorkerHeartbeatService } from "./worker-heartbeat.service.js";

/** The `copy` role (lease (73106, 1)): real-money work and its signal
 * source. The running watcher (the trade feed and its self-alert), the
 * live engine with its stops, closes, settler, setup driver and aborts, the
 * funding monitor and the terminal settlement loop (CopyLiveWorkerModule).
 * RulesModule: the alerts of the actions its fast path stores are
 * evaluated in-process at once, as before (the `read` worker's outbox drain
 * still replays any that were interrupted). */
const COPY_MODULES = [WatcherRuntimeModule, CopyLiveWorkerModule, RulesModule];

/** The `read` role (lease (73106, 2)): every schedule that only reads
 * Hyperliquid or touches no exchange: snapshots, sweeps and catch-ups, the
 * backfill window and queue, the leaderboard import, analysis history and
 * tracked analytics, the discovery pool, cohorts, the archive ingest,
 * retention, the outbox drain, the Telegram bot, the default rules' seed,
 * paper copy, follower snapshots and receipts, and the revenue snapshot.
 * WatcherModule's capabilities only: no second feed. */
const READ_MODULES = [
  WatcherModule,
  SchedulerModule,
  BackfillWorkerModule,
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
  CopyReportingWorkerModule,
  RevenueWorkerModule,
];

/**
 * Everything that runs on its own, by WORKER_ROLE (runtime/worker-role.ts):
 * `all` (unset, today's single worker) imports both sets. Only
 * `AppModule.worker()` imports it; the api process constructs none of
 * these and has no ScheduleModule, so no `@Cron` / `@Interval` fires there.
 */
@Module({})
export class WorkerModule {
  static forRole(role: WorkerRole = "all"): DynamicModule {
    const imports = role === "copy" ? COPY_MODULES : role === "read" ? READ_MODULES : [...COPY_MODULES, ...READ_MODULES];
    return {
      module: WorkerModule,
      imports: [HyperliquidModule, ...imports],
      providers: [WorkerHeartbeatService, ActionRelay],
      exports: [WorkerHeartbeatService],
    };
  }
}
