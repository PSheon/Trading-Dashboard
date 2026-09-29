import { Body, Controller, Get, Post } from "@nestjs/common";
import type { AlertRule } from "@trading-dashboard/shared";

import { Roles } from "../../common/auth/current-user.js";
import { parseUpsertRule } from "../../rules/rule-validation.js";
import { AlertRulesService } from "./alert-rules.service.js";

/** The default rules (no owner): what admins are alerted on for imported
 * leaders. Admin only. Users set CopyDog-style alerts on their favorites
 * instead (PATCH /me/favorites/:address/alert). */
@Roles("admin")
@Controller("alert-rules")
export class AlertRulesController {
  constructor(private readonly alertRulesService: AlertRulesService) {}

  @Get()
  findAll(): Promise<AlertRule[]> {
    return this.alertRulesService.findAll();
  }

  @Post()
  upsert(@Body() body: unknown): Promise<AlertRule> {
    return this.alertRulesService.upsert(parseUpsertRule(body));
  }
}
