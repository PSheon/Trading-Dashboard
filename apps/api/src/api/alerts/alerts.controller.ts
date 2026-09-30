import { ApiDoc } from "../../common/decorators/http.decorator.js";
import { AlertsQueryDto } from "./dto/alerts-query.dto.js";
import { Controller, Get, Query } from "@nestjs/common";
import { type AlertEntry } from "@trading-dashboard/shared/contracts";

import { CurrentUser, type RequestUser } from "../../common/auth/current-user.js";

import { AlertsService } from "./alerts.service.js";
import { alertsVisibleTo } from "../../common/auth/alerts-scope.js";

@Controller("alerts")
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  /** The caller's own alerts; admins and the service token see all. */
  @ApiDoc("Find all")
  @Get()
  findAll(@CurrentUser() user: RequestUser | null, @Query() query: AlertsQueryDto): Promise<AlertEntry[]> {
    return this.alertsService.findAll(query, alertsVisibleTo(user));
  }
}
