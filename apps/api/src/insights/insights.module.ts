import { InsightsRepository } from "./insights.repository.js";
import { Module } from "@nestjs/common";

import { InsightsController } from "./insights.controller.js";
import { InsightsService } from "./insights.service.js";

/** Cross-trader views (Stage 2 §10): the per-coin crowd. Public. */
@Module({
  controllers: [InsightsController],
  providers: [InsightsService, InsightsRepository],
})
export class InsightsModule {}
