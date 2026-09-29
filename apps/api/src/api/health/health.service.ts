import { Injectable } from "@nestjs/common";
import type { HeartbeatResponse } from "@trading-dashboard/shared";

import { env } from "../../config/env.js";
import { RequestBudgeterService } from "../../hyperliquid/request-budgeter.service.js";
import { SchedulerService } from "../../scheduler/scheduler.service.js";
import { WatcherService } from "../../watcher/watcher.service.js";

/** §8 可觀測: the heartbeat the dashboard header shows. */
@Injectable()
export class HealthService {
  constructor(
    private readonly watcher: WatcherService,
    private readonly scheduler: SchedulerService,
    private readonly budgeter: RequestBudgeterService,
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
      lastSweepAt,
      requestsLastMinute: budget.requestsLastMinute,
      weightLastMinute: budget.weightLastMinute,
      queuedRequests: this.budgeter.queued(),
      fillsUnavailable,
      dryRun: env.telegramDryRun(),
      now: new Date(),
    };
  }
}
