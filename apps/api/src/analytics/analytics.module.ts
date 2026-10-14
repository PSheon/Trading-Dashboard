import { Module } from "@nestjs/common";

import { RoundTripRepository } from "./round-trip.repository.js";
import { RoundTripService } from "./round-trip.service.js";

/** Shared round-trip reconstruction for Notify and the dashboard, in its own
 * module so neither depends on the other. */
@Module({
  providers: [RoundTripRepository, RoundTripService],
  exports: [RoundTripService],
})
export class AnalyticsModule {}
