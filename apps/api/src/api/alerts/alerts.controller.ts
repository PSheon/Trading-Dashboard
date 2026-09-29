import { Controller, Get, Query } from "@nestjs/common";
import { alertsQuerySchema, type AlertEntry } from "@trading-dashboard/shared";

import { CurrentUser, type RequestUser } from "../../common/auth/current-user.js";
import { parseOr400 } from "../../common/http/validation.js";
import { AlertsService, alertsVisibleTo } from "./alerts.service.js";

@Controller("alerts")
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  /** The caller's own alerts; admins and the service token see all. */
  @Get()
  findAll(@CurrentUser() user: RequestUser | null, @Query() query: Record<string, unknown>): Promise<AlertEntry[]> {
    return this.alertsService.findAll(parseOr400(alertsQuerySchema, query), alertsVisibleTo(user));
  }
}
