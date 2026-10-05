import { ApiDoc } from "../../common/decorators/http.decorator.js";
import { SkipTransform } from "../../common/decorators/http.decorator.js";
import { Controller, Get } from "@nestjs/common";
import type { HeartbeatResponse, PublicHealth } from "@trading-dashboard/shared/contracts";

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
   * figures are operational detail (the admin system overview).
   */
  @Public()
  @ApiDoc("Public status")
  @Get()
  async heartbeat(): Promise<PublicHealth> {
    const { feedConnected } = await shared(this.healthService);
    return { status: feedConnected ? "ok" : "degraded", feedConnected, now: new Date().toISOString() };
  }
}
