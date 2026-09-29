import { Controller, Get } from "@nestjs/common";
import type { HeartbeatResponse } from "@trading-dashboard/shared/contracts";

import { Public } from "../../common/auth/public.decorator.js";
import { HealthService } from "./health.service.js";

@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** Heartbeat/liveness; open to anyone. */
  @Public()
  @Get()
  heartbeat(): Promise<HeartbeatResponse> {
    return this.healthService.heartbeat();
  }
}
