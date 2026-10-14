import { Module } from "@nestjs/common";

import { WorkerFleetService } from "./worker-fleet.service.js";

/** One shared WorkerFleetService for the health routes and the admin
 * overview. The api only; a worker never imports it. */
@Module({ providers: [WorkerFleetService], exports: [WorkerFleetService] })
export class WorkerFleetModule {}
