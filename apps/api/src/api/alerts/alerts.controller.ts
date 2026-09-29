import { Controller, Get, Query } from "@nestjs/common";
import type { AlertEntry, AlertsQuery } from "@trading-dashboard/shared";

import { CurrentUser, type RequestUser } from "../../common/auth/current-user.js";
import { AlertsService, alertsVisibleTo } from "./alerts.service.js";

@Controller("alerts")
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  /** The caller's own alerts; admins and the service token see all. */
  @Get()
  findAll(@CurrentUser() user: RequestUser | null, @Query() query: AlertsQuery): Promise<AlertEntry[]> {
    return this.alertsService.findAll(query, alertsVisibleTo(user));
  }
}
