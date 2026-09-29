import { LeadersRepository } from "./leaders.repository.js";
import { Module } from "@nestjs/common";

import { AnalyticsModule } from "../../analytics/analytics.module.js";
import { LeadersController } from "./leaders.controller.js";
import { LeadersService } from "./leaders.service.js";

@Module({
  imports: [AnalyticsModule],
  controllers: [LeadersController],
  providers: [LeadersRepository, LeadersService],
})
export class LeadersModule {}
