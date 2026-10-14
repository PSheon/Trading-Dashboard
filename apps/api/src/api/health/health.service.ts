import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { HeartbeatResponse } from "@trading-dashboard/shared/contracts";
import { WorkerFleetService } from "./worker-fleet.service.js";

/** §8 可觀測: the heartbeat the dashboard header shows. The feed, snapshots
 * and sweeps run in the worker, so the api reads the worker's
 * (WorkerFleetService; 503 when it cannot be reached or no WORKER_URL is
 * set). */
@Injectable()
export class HealthService {
  constructor(private readonly fleet: WorkerFleetService) {}

  async heartbeat(): Promise<HeartbeatResponse> {
    try { return await this.fleet.heartbeat(); }
    catch { throw new ServiceUnavailableException("Worker unavailable"); }
  }
}
