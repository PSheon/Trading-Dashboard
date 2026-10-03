import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import type { CopyOrdersResponse, CopyOverviewResponse, CopyStrategy } from "@trading-dashboard/shared/contracts";

import { CurrentUser, requireUserId, type RequestUser } from "../common/auth/current-user.js";
import { ApiDoc } from "../common/decorators/http.decorator.js";
import { CopyStrategyService } from "./copy-strategy.service.js";
import { CopyPerformanceService } from "./copy-performance.service.js";
import { AddCopyFundsDto, CopyEventsQueryDto, CopyHistoryQueryDto, CopyPerformanceQueryDto, CopyStrategyCommandDto, CopyStrategyParamsDto, CreateCopyStrategyDto, PatchCopyStrategyDto } from "./dto/copy.dto.js";

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
  constructor(private readonly copies: CopyStrategyService, private readonly performance: CopyPerformanceService) {}

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
