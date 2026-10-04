import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import { ApiHeader } from "@nestjs/swagger";
import type { Request, Response } from "express";
import type { CopyOrdersResponse, CopyOverviewResponse, CopyStrategy } from "@trading-dashboard/shared/contracts";

import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { ApiDoc, SkipTransform } from "../common/decorators/http.decorator.js";
import { AuthService } from "../common/auth/auth.service.js";
import { ResumeHeader, ResumeHeaderDto } from "../api/actions/dto/resume-header.dto.js";
import { CopyStreamService } from "./copy-stream.service.js";
import { CopyStrategyService } from "./copy-strategy.service.js";
import { CopyPerformanceService } from "./copy-performance.service.js";
import { AddCopyFundsDto, CopyEventsQueryDto, CopyHistoryQueryDto, CopyPerformanceQueryDto, CopyPortfolioQueryDto, CopyTradesQueryDto, CopyStrategyCommandDto, CopyStrategyParamsDto, CreateCopyStrategyDto, PatchCopyStrategyDto } from "./dto/copy.dto.js";

/**
 * The signed-in user's paper copies (Stage 4 step 3). Not @Public: 401
 * without a token, 403 for the service token. Every strategy route acts
 * only on a strategy the caller owns (404 otherwise). Database only, except
 * that valuing open positions reads allMids (weight 2, shared 3 s cache)
 * and starting a copy with 跟單目前持倉 reads the leader's
 * clearinghouseState (weight 2).
 */
@Controller("me/copy")
export class CopyController {
  constructor(
    private readonly copies: CopyStrategyService,
    private readonly performance: CopyPerformanceService,
    private readonly streams: CopyStreamService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Server-sent events: the caller's own copy events as they commit
   * (`event: copy`, SSE id = event id), a heartbeat comment every ~15 s.
   * Resume with `Last-Event-ID` (replays up to 200 missed events; `reset`
   * beyond). Browsers use fetch streaming, so the Authorization header goes
   * along; it is rechecked before every delivery.
   */
  @SkipTransform()
  @ApiHeader({ name: "Last-Event-ID", required: false, description: "Positive int64 copy event id; replays up to 200 missed events.", schema: { type: "string", pattern: "^[1-9]\\d{0,18}$" } })
  @ApiDoc("Stream my copy events")
  @Get("stream")
  async stream(@CurrentUser() user: RequestUser | null, @ResumeHeader() resume: ResumeHeaderDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = requireUserId(user);
    const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : undefined;
    const authorize = async () => {
      if (!token) return false;
      const outcome = await this.auth.authenticate(token);
      return outcome.status === "user" && outcome.user.kind === "user" && outcome.user.id === userId;
    };
    await this.streams.open(req, res, userId, { lastEventId: resume.lastEventId ? BigInt(resume.lastEventId) : undefined, authorize });
  }

  @ApiDoc("Get my paper copies")
  @Get()
  overview(@CurrentUser() user: RequestUser | null): Promise<CopyOverviewResponse> {
    return this.copies.overview(requireUserId(user));
  }

  @ApiDoc("Start a paper copy")
  @Post("strategies")
  create(@Body() body: CreateCopyStrategyDto, @CurrentUser() user: RequestUser | null): Promise<CopyStrategy> {
    return this.copies.create(requireUserId(user), body);
  }

  @ApiDoc("Edit a paper copy (new version)")
  @Patch("strategies/:id")
  patch(@Param() params: CopyStrategyParamsDto, @Body() body: PatchCopyStrategyDto, @CurrentUser() user: RequestUser | null): Promise<CopyStrategy> {
    return this.copies.patch(requireUserId(user), params.id, body);
  }

  @ApiDoc("Add paper funds to a copy")
  @Post("strategies/:id/funds")
  @HttpCode(200)
  addFunds(@Param() params: CopyStrategyParamsDto, @Body() body: AddCopyFundsDto, @CurrentUser() user: RequestUser | null): Promise<CopyStrategy> {
    return this.copies.addFunds(requireUserId(user), params.id, body);
  }

  @ApiDoc("Withdraw idle paper collateral")
  @Post("strategies/:id/withdraw-funds")
  @HttpCode(200)
  withdraw(@Param() params: CopyStrategyParamsDto, @Body() body: AddCopyFundsDto, @CurrentUser() user: RequestUser | null): Promise<CopyStrategy> {
    return this.copies.withdrawFunds(requireUserId(user), params.id, body);
  }

  @ApiDoc("Get a copy's observed equity history")
  @Get("strategies/:id/performance")
  history(@Param() params: CopyStrategyParamsDto, @Query() query: CopyPerformanceQueryDto, @CurrentUser() user: RequestUser | null) {
    return this.performance.history(requireUserId(user), params.id, query);
  }

  @ApiDoc("Get my whole paper portfolio's PnL history, today's PnL and each copy's curve")
  @Get("portfolio")
  portfolio(@Query() query: CopyPortfolioQueryDto, @CurrentUser() user: RequestUser | null) {
    return this.performance.portfolio(requireUserId(user), query);
  }

  @ApiDoc("List my closed copy trades (best, worst or latest)")
  @Get("trades")
  trades(@Query() query: CopyTradesQueryDto, @CurrentUser() user: RequestUser | null) {
    return this.performance.trades(requireUserId(user), query);
  }

  @ApiDoc("Replay my confirmed copy events")
  @Get("events")
  events(@Query() query: CopyEventsQueryDto, @CurrentUser() user: RequestUser | null) {
    return this.performance.events(requireUserId(user), query);
  }

  @ApiDoc("Pause, resume, reduce-only, cancel pending, close positions or stop a copy")
  @Post("strategies/:id/commands")
  @HttpCode(200)
  command(@Param() params: CopyStrategyParamsDto, @Body() body: CopyStrategyCommandDto, @CurrentUser() user: RequestUser | null): Promise<CopyStrategy> {
    return this.copies.command(requireUserId(user), params.id, body.command, body.idempotencyKey);
  }

  @ApiDoc("List a copy's paper orders")
  @Get("strategies/:id/orders")
  orders(@Param() params: CopyStrategyParamsDto, @Query() query: CopyHistoryQueryDto, @CurrentUser() user: RequestUser | null): Promise<CopyOrdersResponse> {
    return this.copies.orders(requireUserId(user), params.id, query);
  }
  @ApiDoc("List my copy's exact-decimal accounting ledger")
  @Get("strategies/:id/ledger")
  ledger(@Param() params: CopyStrategyParamsDto, @Query() query: CopyHistoryQueryDto, @CurrentUser() user: RequestUser | null) {
    return this.copies.ledger(requireUserId(user), params.id, query);
  }

  @ApiDoc("List my copy's simulated fills")
  @Get("strategies/:id/fills")
  fills(@Param() params: CopyStrategyParamsDto, @Query() query: CopyHistoryQueryDto, @CurrentUser() user: RequestUser | null) {
    return this.copies.fills(requireUserId(user), params.id, query);
  }

}
