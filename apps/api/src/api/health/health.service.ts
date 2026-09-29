import { Injectable } from "@nestjs/common";
import type { HeartbeatResponse } from "@trading-dashboard/shared";

import { env } from "../../config/env.js";

/**
 * §8 可觀測: heartbeat — is the Watcher alive, when was the last fill, how
 * many requests today, is DRY_RUN on. Backed by real state (a heartbeat
 * table written every minute) once the Watcher exists; until then this
 * reports honest defaults instead of throwing, since the M1 web status page
 * depends on this endpoint responding.
 */
@Injectable()
export class HealthService {
  async heartbeat(): Promise<HeartbeatResponse> {
    return {
      wsConnected: false,
      lastFillAt: null,
      requestsToday: 0,
      dryRun: env.dryRun(),
      now: new Date(),
    };
  }
}
