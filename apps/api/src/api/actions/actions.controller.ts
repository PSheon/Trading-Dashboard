import { Controller, Get, Query } from "@nestjs/common";
import type { Action, ActionsFeedQuery } from "@trading-dashboard/shared";

import { ActionsService } from "./actions.service.js";

@Controller("actions")
export class ActionsController {
  constructor(private readonly actionsService: ActionsService) {}

  @Get()
  findFeed(@Query() query: ActionsFeedQuery): Promise<Action[]> {
    return this.actionsService.findFeed(query);
  }
}
