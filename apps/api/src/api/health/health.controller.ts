import { Controller, Get } from "@nestjs/common";
import type { HeartbeatResponse } from "@trading-dashboard/shared";

import { Public } from "../../common/auth/public.decorator.js";
import { HealthService } from "./health.service.js";

@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /** Only unauthenticated route in the API (§8 安全) — heartbeat/liveness. */
  @Public()
  @Get()
  heartbeat(): Promise<HeartbeatResponse> {
    return this.healthService.heartbeat();
  }
}
