import { Module } from "@nestjs/common";

import { AlertRulesRepository } from "./alert-rules.repository.js";
import { AlertRulesController } from "./alert-rules.controller.js";
import { AlertRulesService } from "./alert-rules.service.js";

@Module({
  controllers: [AlertRulesController],
  providers: [AlertRulesRepository, AlertRulesService],
})
export class AlertRulesModule {}
