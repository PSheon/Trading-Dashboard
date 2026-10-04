import { ApiDoc } from "../../common/decorators/http.decorator.js";
import { AlertsQueryDto } from "./dto/alerts-query.dto.js";
import { Controller, Get, Query } from "@nestjs/common";
import { type AlertEntry } from "@trading-dashboard/shared/contracts";

import { CurrentUser, type RequestUser } from "../../common/auth/current-user.js";

import { AlertsService } from "./alerts.service.js";
import { alertsVisibleTo, redactAlerts } from "../../common/auth/alerts-scope.js";

@Controller("alerts")
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  /** The caller's own alerts; with alerts.readAll (operators, admins, the
   * service token) everyone's, without other recipients' chat ids. */
  @ApiDoc("Find all", "Your own alerts; with alerts.readAll everyone's, without other recipients' Telegram chat ids")
  @Get()
  async findAll(@CurrentUser() user: RequestUser | null, @Query() query: AlertsQueryDto): Promise<AlertEntry[]> {
    return redactAlerts(await this.alertsService.findAll(query, alertsVisibleTo(user)), user);
  }
}
