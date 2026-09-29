import { Module } from "@nestjs/common";

import { AlertRulesController } from "./alert-rules.controller.js";
import { AlertRulesService } from "./alert-rules.service.js";

@Module({
  controllers: [AlertRulesController],
  providers: [AlertRulesService],
})
export class AlertRulesModule {}
