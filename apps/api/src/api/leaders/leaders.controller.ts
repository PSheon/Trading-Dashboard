import { RequirePermissions } from "../../common/auth/permissions.js";
import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import type { Leader, LeaderDetailResponse, LeaderSummary } from "@trading-dashboard/shared/contracts";

import {
  addressSchema,
  chainSchema,
  leaderDetailQuerySchema,
  leadersQuerySchema,
  patchLeaderRequestSchema,
} from "@trading-dashboard/shared/contracts";
import { parseOr400 } from "../../common/http/validation.js";
import { CurrentUser, type RequestUser } from "../../common/auth/current-user.js";
import { Public } from "../../common/auth/public.decorator.js";
import { alertsVisibleTo } from "../../common/auth/alerts-scope.js";
import { LeadersService } from "./leaders.service.js";

@Controller("leaders")
export class LeadersController {
  constructor(private readonly leadersService: LeadersService) {}

  /** Market data: public. */
  @Public()
  @Get()
  findAll(@Query() query: Record<string, unknown>): Promise<LeaderSummary[]> {
    return this.leadersService.findAll(parseOr400(leadersQuerySchema, query));
  }

  /** D3: current positions, fill history, equity curve, coin distribution,
   * alert history. `?equityInterval=hour|5m` — defaults to `hour` (§11:
   * "詳情頁預設每小時一點，可切 5 分鐘"). Public; the alert history is the
   * caller's own (empty when anonymous, everyone's for admins). */
  @Public()
  @Get(":chain/:address")
  findDetail(
    @CurrentUser() user: RequestUser | null,
    @Param("chain") chain: string,
    @Param("address") address: string,
    @Query("equityInterval") equityInterval?: "hour" | "5m",
  ): Promise<LeaderDetailResponse> {
    return this.leadersService.findDetail(
      parseOr400(chainSchema, chain),
      parseOr400(addressSchema, address).toLowerCase(),
      parseOr400(leaderDetailQuerySchema, { equityInterval }).equityInterval ?? "hour",
      alertsVisibleTo(user),
    );
  }

  /** A3: label/tier/notes/active. */
  @RequirePermissions("leaders.manage")
  @Patch(":chain/:address")
  update(
    @Param("chain") chain: string,
    @Param("address") address: string,
    @Body() body: unknown,
    @CurrentUser() actor: RequestUser | null,
  ): Promise<Leader> {
    return this.leadersService.update(parseOr400(chainSchema, chain), parseOr400(addressSchema, address).toLowerCase(), parseOr400(patchLeaderRequestSchema, body), actor);
  }
}
