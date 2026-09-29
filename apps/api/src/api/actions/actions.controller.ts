import { Controller, Get, Param, Query } from "@nestjs/common";
import type { ActionFeedItem, ActionsFeedQuery, Fill } from "@trading-dashboard/shared";

import { ActionsService } from "./actions.service.js";

@Controller("actions")
export class ActionsController {
  constructor(private readonly actionsService: ActionsService) {}

  @Get()
  findFeed(@Query() query: ActionsFeedQuery): Promise<ActionFeedItem[]> {
    return this.actionsService.findFeed(query);
  }

  /** D1: expand a feed row to see its constituent fills. */
  @Get(":id/fills")
  getFills(@Param("id") id: string): Promise<Fill[]> {
    return this.actionsService.getFillsForAction(BigInt(id));
  }
}
