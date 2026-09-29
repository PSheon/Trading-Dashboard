import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import { actionsFeedQuerySchema, type ActionFeedItem, type Fill } from "@trading-dashboard/shared";

import { CurrentUser, type RequestUser } from "../../common/auth/current-user.js";
import { Public } from "../../common/auth/public.decorator.js";
import { parseOr400 } from "../../common/http/validation.js";
import { ActionsService } from "./actions.service.js";

/** Market data: public, except `?scope=favorites`, which needs a signed-in
 * user. */
@Public()
@Controller("actions")
export class ActionsController {
  constructor(private readonly actionsService: ActionsService) {}

  @Get()
  findFeed(@CurrentUser() user: RequestUser | null, @Query() raw: Record<string, unknown>): Promise<ActionFeedItem[]> {
    const query = parseOr400(actionsFeedQuerySchema, raw);
    if (query.scope === "favorites") {
      if (!user) throw new UnauthorizedException("Sign in to see your favorites");
      if (user.kind !== "user") throw new ForbiddenException("Only a signed-in user has favorites");
      return this.actionsService.findFeed(query, user.id);
    }
    return this.actionsService.findFeed(query);
  }

  /** D1: expand a feed row to see its constituent fills. */
  @Get(":id/fills")
  getFills(@Param("id") id: string): Promise<Fill[]> {
    if (!/^\d+$/.test(id)) throw new BadRequestException("id must be an integer");
    return this.actionsService.getFillsForAction(BigInt(id));
  }
}
