import { AppConfig } from "../../config/app-config.js";
import { Injectable, Optional, ServiceUnavailableException } from "@nestjs/common";
import type { HeartbeatResponse } from "@trading-dashboard/shared/contracts";

import { ArchiveIngestService } from "../../ingest/archive-ingest.service.js";
import { RequestBudgeterService } from "../../hyperliquid/request-budgeter.service.js";
import { SchedulerService } from "../../scheduler/scheduler.service.js";
import { WatcherService } from "../../watcher/watcher.service.js";

/** §8 可觀測: the heartbeat the dashboard header shows. */
@Injectable()
export class HealthService {
  constructor(
    private readonly config: AppConfig,
    private readonly watcher: WatcherService,
    private readonly scheduler: SchedulerService,
    private readonly budgeter: RequestBudgeterService,
    @Optional() private readonly archive?: ArchiveIngestService,
  ) {}

  async heartbeat(): Promise<HeartbeatResponse> {
    if (this.config.value.app.role === "api") {
      try {
        const response = await fetch(new URL("/health", this.config.value.app.workerUrl), { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error("Worker unavailable");
        return await response.json() as HeartbeatResponse;
      } catch { throw new ServiceUnavailableException("Worker unavailable"); }
    }
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
      fillsUnavailable,
      dryRun: this.config.value.telegram.dryRun,
      // Progress of the S3 archive ingest; a failed read must not fail the heartbeat.
      archive: this.archive?.enabled ? await this.archive.status().catch(() => undefined) : undefined,
      now: new Date(),
    };
  }
}
