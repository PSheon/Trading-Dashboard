import { Module } from "@nestjs/common";

import { LeadersController } from "./leaders.controller.js";
import { LeadersService } from "./leaders.service.js";

@Module({
  controllers: [LeadersController],
  providers: [LeadersService],
})
export class LeadersModule {}
