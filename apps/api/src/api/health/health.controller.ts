import { ApiDoc } from "../../common/decorators/http.decorator.js";
import { SkipTransform } from "../../common/decorators/http.decorator.js";
import { Controller, Get } from "@nestjs/common";
import type { HeartbeatResponse } from "@trading-dashboard/shared/contracts";

import { Public } from "../../common/auth/public.decorator.js";
import { HealthService } from "./health.service.js";
import { CachedProbe } from "./cached-probe.js";

@SkipTransform()
@Controller("health")
export class HealthController {
  /** One heartbeat per second is shared by every caller. */
  private readonly cache = new CachedProbe<HeartbeatResponse>();

  constructor(private readonly healthService: HealthService) {}

  /** Heartbeat/liveness; open to anyone, cached for a second. */
  @Public()
  @ApiDoc("Heartbeat")
  @Get()
  heartbeat(): Promise<HeartbeatResponse> {
    return this.cache.get(() => this.healthService.heartbeat());
  }
}
