import { Injectable, Optional } from "@nestjs/common";
import type { HeartbeatResponse } from "@trading-dashboard/shared/contracts";

import { AppConfig } from "../config/app-config.js";
import { DiscoveryPoolService } from "../discovery/discovery-pool.service.js";
import { ArchiveIngestService } from "../ingest/archive-ingest.service.js";
import { RequestBudgeterService } from "../hyperliquid/request-budgeter.service.js";
import { SchedulerService } from "../scheduler/scheduler.service.js";
import { WatcherService } from "../watcher/watcher.service.js";

/** §8 可觀測: the worker's own heartbeat (feed, snapshots, sweeps, budget,
 * discovery and archive progress), served on its health port and read by
 * the api's `HealthService`. */
@Injectable()
export class WorkerHeartbeatService {
  constructor(
    private readonly config: AppConfig,
    private readonly watcher: WatcherService,
    private readonly scheduler: SchedulerService,
    private readonly budgeter: RequestBudgeterService,
    @Optional() private readonly archive?: ArchiveIngestService,
    @Optional() private readonly pool?: DiscoveryPoolService,
  ) {}

  async heartbeat(): Promise<HeartbeatResponse> {
    const { feed, lastFillAt, lastSweepAt, fillsUnavailable } = this.watcher.getHeartbeat();
    const budget = this.budgeter.introspect();
    return {
      feedConnected: feed.socketsTotal > 0 && feed.socketsOpen === feed.socketsTotal,
      feedSocketsOpen: feed.socketsOpen,
      feedSocketsTotal: feed.socketsTotal,
      marketsSubscribed: feed.markets,
      feedDisconnectedSince: feed.disconnectedSince,
      lastTradeAt: feed.lastTradeAt,
      lastFillAt,
      lastSnapshotAt: this.scheduler.lastSnapshotAt,
      lastSnapshotAttemptAt: this.scheduler.lastSnapshotAttemptAt,
      lastSnapshotFailureAt: this.scheduler.lastSnapshotFailureAt,
      lastSweepAt,
      requestsLastMinute: budget.requestsLastMinute,
      weightLastMinute: budget.weightLastMinute,
      queuedRequests: this.budgeter.queued(),
      budget: {
        effectivePerMin: budget.effectiveBudgetPerMin,
        pageWeightLastMinute: budget.pageWeightLastMinute,
        reserveTokens: Math.round(budget.reserveTokens),
        reserveCapacity: budget.reserveCapacity,
        backgroundFactor: Math.round(budget.backgroundFactor * 100) / 100,
        consumers: budget.consumers,
        caps: budget.consumerCaps,
      },
      // Age of the boards' and home rows' figures; a failed read must not fail the heartbeat.
      discovery: await this.pool?.freshness().then((f) => ({
        visibleRows: f.visible.rows, medianVisibleAgeSeconds: f.visible.medianAgeSeconds, oldestVisibleAgeSeconds: f.visible.oldestAgeSeconds,
        poolRows: f.pool.rows, poolReady: f.pool.ready, medianPoolAgeSeconds: f.pool.medianAgeSeconds, oldestPoolAgeSeconds: f.pool.oldestAgeSeconds,
      })).catch(() => undefined),
      fillsUnavailable,
      dryRun: this.config.value.telegram.dryRun,
      // Progress of the S3 archive ingest; a failed read must not fail the heartbeat.
      archive: this.archive?.enabled ? await this.archive.status().catch(() => undefined) : undefined,
      now: new Date(),
    };
  }
}
