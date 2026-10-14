import { Module } from "@nestjs/common";

import { WorkerFleetService } from "./worker-fleet.service.js";

/** The api's view of its workers (WorkerFleetService), shared by the health
 * routes and the admin system overview: one instance, one memory of what
 * the workers' heartbeats said. The api only; a worker never imports it. */
@Module({ providers: [WorkerFleetService], exports: [WorkerFleetService] })
export class WorkerFleetModule {}
