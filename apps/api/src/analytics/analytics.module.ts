import { Module } from "@nestjs/common";

import { RoundTripRepository } from "./round-trip.repository.js";
import { RoundTripService } from "./round-trip.service.js";

/** Shared win-rate/PnL/hold-time reconstruction (§2 of the M2 task), used
 * by both the Rules/Notify path (N1 message content) and the dashboard
 * (D2/D3). Kept out of RulesModule/ApiModule so neither has to depend on
 * the other just to reach this. */
@Module({
  providers: [RoundTripRepository, RoundTripService],
  exports: [RoundTripService],
})
export class AnalyticsModule {}
