import { AppConfig } from "../../config/app-config.js";
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { HeartbeatResponse } from "@trading-dashboard/shared/contracts";

/** §8 可觀測: the heartbeat the dashboard header shows. The feed, snapshots
 * and sweeps run in the worker, so the api reads the worker's (503 when it
 * cannot be reached or no WORKER_URL is set). */
@Injectable()
export class HealthService {
  constructor(private readonly config: AppConfig) {}

  async heartbeat(): Promise<HeartbeatResponse> {
    const workerUrl = this.config.value.app.workerUrl;
    if (!workerUrl) throw new ServiceUnavailableException("Worker unavailable");
    try {
      const response = await fetch(new URL("/health", workerUrl), { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error("Worker unavailable");
      return await response.json() as HeartbeatResponse;
    } catch { throw new ServiceUnavailableException("Worker unavailable"); }
  }
}
