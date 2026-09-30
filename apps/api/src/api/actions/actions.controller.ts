import { ApiDoc } from "../../common/decorators/http.decorator.js";
import { ApiHeader } from "@nestjs/swagger";
import { ActionsFeedQueryDto, ActionsStreamQueryDto } from "./dto/action-query.dto.js";
import { ActionIdParamsDto } from "../../common/dto/params.dto.js";
import { SkipTransform } from "../../common/decorators/http.decorator.js";
import { ResumeHeader, ResumeHeaderDto } from "./dto/resume-header.dto.js";
import { Controller, ForbiddenException, Get, Param, Query, Req, Res, UnauthorizedException } from "@nestjs/common";
import { type ActionFeedItem, type Fill } from "@trading-dashboard/shared/contracts";
import type { Request, Response } from "express";

import { AuthService } from "../../common/auth/auth.service.js";
import { CurrentUser, type RequestUser } from "../../common/auth/current-user.js";
import { Public } from "../../common/auth/public.decorator.js";

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
    private readonly auth: AuthService,
  ) {}

  @ApiDoc("Find feed")
  @Get()
  findFeed(@CurrentUser() user: RequestUser | null, @Query() query: ActionsFeedQueryDto): Promise<ActionFeedItem[]> {
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
  @SkipTransform()
  @ApiHeader({ name: "Last-Event-ID", required: false, description: "Positive int64 action id; resumes up to 200 missed rows. Empty or whitespace-only values are treated as absent.", schema: { type: "string", pattern: "^[1-9]\\d{0,18}$" } })
  @ApiDoc("Stream")
  @Get("stream")
  async stream(
    @CurrentUser() user: RequestUser | null,
    @Query() query: ActionsStreamQueryDto,
    @ResumeHeader() resume: ResumeHeaderDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const favoritesOf = query.scope === "favorites" ? favoritesOwner(user) : undefined;
    const lastEventId = resume.lastEventId
      ? BigInt(resume.lastEventId)
      : undefined;
    const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : undefined;
    const authorize = favoritesOf === undefined ? undefined : async () => {
      if (!token) return false;
      const outcome = await this.auth.authenticate(token);
      return outcome.status === "user" && outcome.user.kind === "user" && outcome.user.id === favoritesOf;
    };
    await this.streams.open(req, res, query, { favoritesOf, lastEventId, authorize });
  }

  /** D1: expand a feed row to see its constituent fills. */
  @ApiDoc("Get fills")
  @Get(":id/fills")
  getFills(@Param() params: ActionIdParamsDto): Promise<Fill[]> {
    return this.actionsService.getFillsForAction(BigInt(params.id));
  }
}
