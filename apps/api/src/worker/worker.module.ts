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

/** The `copy` role (lease (73106, 1)): real-money work and its signal source (the trade
 * feed, the live engine, funding and settlement). RulesModule evaluates the fast path's
 * alerts in-process; the `read` worker's outbox drain replays interrupted ones. */
const COPY_MODULES = [WatcherRuntimeModule, CopyLiveWorkerModule, RulesModule];

/** The `read` role (lease (73106, 2)): every schedule that only reads Hyperliquid or
 * touches no exchange. WatcherModule's capabilities only: no second feed. */
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

/** Background work by WORKER_ROLE (`all`, the default, imports both sets). Only
 * `AppModule.worker()` imports it, so no `@Cron` / `@Interval` fires in the api process. */
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
