import { Controller, Get, Query } from "@nestjs/common";
import type { AlertEntry, AlertsQuery } from "@trading-dashboard/shared";

import { AlertsService } from "./alerts.service.js";

@Controller("alerts")
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get()
  findAll(@Query() query: AlertsQuery): Promise<AlertEntry[]> {
    return this.alertsService.findAll(query);
  }
}
