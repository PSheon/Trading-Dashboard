import { Module } from "@nestjs/common";

import { ReadinessController } from "./readiness.controller.js";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";
import { WorkerFleetModule } from "./worker-fleet.module.js";

/** The api's health routes. The heartbeat itself is the worker's
 * (WorkerHeartbeatService), read over WORKER_URL (WorkerFleetService). */
@Module({
  imports: [WorkerFleetModule],
  controllers: [HealthController, ReadinessController],
  providers: [HealthService],
})
export class HealthModule {}
