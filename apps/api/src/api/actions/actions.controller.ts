import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import {
  actionIdCursorSchema,
  actionsFeedQuerySchema,
  actionsStreamQuerySchema,
  type ActionFeedItem,
  type Fill,
} from "@trading-dashboard/shared/contracts";
import type { Request, Response } from "express";

import { CurrentUser, type RequestUser } from "../../common/auth/current-user.js";
import { Public } from "../../common/auth/public.decorator.js";
import { parseOr400 } from "../../common/http/validation.js";
import { ActionStreamService } from "./action-stream.service.js";
import { ActionsService } from "./actions.service.js";

/** `?scope=favorites` needs a signed-in user (not a service caller). */
function favoritesOwner(user: RequestUser | null): number {
  if (!user) throw new UnauthorizedException("Sign in to see your favorites");
  if (user.kind !== "user") throw new ForbiddenException("Only a signed-in user has favorites");
  return user.id;
}

/** Market data: public, except `?scope=favorites`, which needs a signed-in
 * user. */
@Public()
@Controller("actions")
export class ActionsController {
  constructor(
    private readonly actionsService: ActionsService,
    private readonly streams: ActionStreamService,
  ) {}

  @Get()
  findFeed(@CurrentUser() user: RequestUser | null, @Query() raw: Record<string, unknown>): Promise<ActionFeedItem[]> {
    const query = parseOr400(actionsFeedQuerySchema, raw);
    if (query.scope === "favorites") return this.actionsService.findFeed(query, favoritesOwner(user));
    return this.actionsService.findFeed(query);
  }

  /**
   * Server-sent events: each new feed row matching the filters (`action`),
   * slow-path corrections (`update`), a heartbeat comment every ~15 s.
   * Resume with `Last-Event-ID: <action id>` (replays up to 200 missed
   * rows). Browsers call it with fetch streaming, so the Authorization
   * header works as on GET /actions. 429 beyond the per-IP/global limits.
   */
  @Get("stream")
  async stream(
    @CurrentUser() user: RequestUser | null,
    @Query() raw: Record<string, unknown>,
    @Headers("last-event-id") lastEventIdHeader: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const query = parseOr400(actionsStreamQuerySchema, raw);
    const favoritesOf = query.scope === "favorites" ? favoritesOwner(user) : undefined;
    const lastEventId = lastEventIdHeader?.trim()
      ? BigInt(parseOr400(actionIdCursorSchema, lastEventIdHeader.trim()))
      : undefined;
    await this.streams.open(req, res, query, { favoritesOf, lastEventId });
  }

  /** D1: expand a feed row to see its constituent fills. */
  @Get(":id/fills")
  getFills(@Param("id") id: string): Promise<Fill[]> {
    if (!/^\d+$/.test(id)) throw new BadRequestException("id must be an integer");
    return this.actionsService.getFillsForAction(BigInt(id));
  }
}
