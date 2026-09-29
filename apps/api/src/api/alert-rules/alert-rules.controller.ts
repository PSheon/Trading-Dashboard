import { Body, Controller, Get, Post } from "@nestjs/common";
import type {
  AlertRule,
  UpsertAlertRuleRequest,
} from "@trading-dashboard/shared";

import { AlertRulesService } from "./alert-rules.service.js";

@Controller("alert-rules")
export class AlertRulesController {
  constructor(private readonly alertRulesService: AlertRulesService) {}

  @Get()
  findAll(): Promise<AlertRule[]> {
    return this.alertRulesService.findAll();
  }

  @Post()
  upsert(@Body() body: UpsertAlertRuleRequest): Promise<AlertRule> {
    return this.alertRulesService.upsert(body);
  }
}
