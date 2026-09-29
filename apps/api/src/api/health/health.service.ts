import { Injectable } from "@nestjs/common";
import type { HeartbeatResponse } from "@trading-dashboard/shared";

import { env } from "../../config/env.js";
import { RequestBudgeterService } from "../../hyperliquid/request-budgeter.service.js";
import { WatcherService } from "../../watcher/watcher.service.js";

/**
 * §8 可觀測: heartbeat — is the Watcher alive, when was the last fill, how
 * many requests recently, is DRY_RUN on. Backed by real state now:
 * `pollerAlive`/`lastFillAt` come from the polling loop itself, and
 * `requestsLastMinute` from the shared request budgeter's own sliding
 * window (the same one every Hyperliquid call is paced through).
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly watcher: WatcherService,
    private readonly budgeter: RequestBudgeterService,
  ) {}

  async heartbeat(): Promise<HeartbeatResponse> {
    const watcherHeartbeat = this.watcher.getHeartbeat();
    const budget = this.budgeter.introspect();

    return {
      pollerAlive: watcherHeartbeat.pollerAlive,
      lastFillAt: watcherHeartbeat.lastFillAt,
      requestsLastMinute: budget.requestsLastMinute,
      dryRun: env.dryRun(),
      now: new Date(),
    };
  }
}
