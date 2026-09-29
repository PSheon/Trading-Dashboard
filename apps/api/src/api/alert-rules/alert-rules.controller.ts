import { CurrentUser, type RequestUser } from "../../common/auth/current-user.js";
import { Body, Controller, Get, Post } from "@nestjs/common";
import type { AlertRule } from "@trading-dashboard/shared/contracts";

import { RequirePermissions } from "../../common/auth/permissions.js";
import { parseUpsertRule } from "../../rules/rule-validation.js";
import { AlertRulesService } from "./alert-rules.service.js";

/** The default rules (no owner): what admins are alerted on for imported
 * leaders. Admin only. Users set CopyDog-style alerts on their favorites
 * instead (PATCH /me/favorites/:address/alert). */
@RequirePermissions("rules.read")
@Controller("alert-rules")
export class AlertRulesController {
  constructor(private readonly alertRulesService: AlertRulesService) {}

  @Get()
  findAll(): Promise<AlertRule[]> {
    return this.alertRulesService.findAll();
  }

  @RequirePermissions("rules.manage")
  @Post()
  upsert(@Body() body: unknown, @CurrentUser() actor: RequestUser | null): Promise<AlertRule> {
    return this.alertRulesService.upsert(parseUpsertRule(body), actor);
  }
}
