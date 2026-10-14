import { Module } from "@nestjs/common";

import { EgressIdentityController } from "./egress-identity.controller.js";
import { ReadinessController } from "./readiness.controller.js";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";
import { WorkerFleetModule } from "./worker-fleet.module.js";

/** The api's health routes. The heartbeat itself is the worker's
 * (WorkerHeartbeatService), read over WORKER_URL (WorkerFleetService).
 * /health/egress: the api's public IP for the copy worker's lease gate. */
@Module({
  imports: [WorkerFleetModule],
  controllers: [HealthController, ReadinessController, EgressIdentityController],
  providers: [HealthService],
})
export class HealthModule {}
