import { ApiDoc } from "../../common/decorators/http.decorator.js";
import { SkipTransform } from "../../common/decorators/http.decorator.js";
import { Controller, Get, Header } from "@nestjs/common";
import type { HeartbeatResponse, PublicHealth } from "@trading-dashboard/shared/contracts";

import { RequirePermissions } from "../../common/auth/permissions.js";
import { Public } from "../../common/auth/public.decorator.js";
import { HealthService } from "./health.service.js";
import { CachedProbe } from "./cached-probe.js";

/** One heartbeat per second is shared by every caller, public or admin. */
const heartbeats = new WeakMap<HealthService, CachedProbe<HeartbeatResponse>>();
function shared(service: HealthService): Promise<HeartbeatResponse> {
  let probe = heartbeats.get(service);
  if (!probe) heartbeats.set(service, (probe = new CachedProbe<HeartbeatResponse>()));
  return probe.get(() => service.heartbeat());
}

@SkipTransform()
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Liveness for anyone, cached for a second: is the data feed up. Nothing
   * else of the heartbeat leaves here (review finding 36): the request
   * budget and its consumers, the queues, dry-run, discovery and archive
   * figures are operational detail (GET /admin/system/heartbeat).
   */
  @Public()
  @ApiDoc("Public status")
  @Get()
  async heartbeat(): Promise<PublicHealth> {
    const { feedConnected } = await shared(this.healthService);
    return { status: feedConnected ? "ok" : "degraded", feedConnected, now: new Date().toISOString() };
  }
}

/** The whole heartbeat, for admins: what the system page shows. In the api
 * role it is the worker's (503 when the worker can't be reached). */
@Controller("admin/system")
@RequirePermissions("admin.access")
export class AdminHeartbeatController {
  constructor(private readonly healthService: HealthService) {}

  @ApiDoc("Full heartbeat: feed, budget, queues, discovery, archive ingest")
  @Header("Cache-Control", "no-store")
  @Get("heartbeat")
  heartbeat(): Promise<HeartbeatResponse> {
    return shared(this.healthService);
  }
}
