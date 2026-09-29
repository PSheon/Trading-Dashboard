import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import type {
  Leader,
  LeaderDetailResponse,
  LeaderSummary,
  LeadersQuery,
  PatchLeaderRequest,
} from "@trading-dashboard/shared";

import { CurrentUser, Roles, type RequestUser } from "../../common/auth/current-user.js";
import { Public } from "../../common/auth/public.decorator.js";
import { alertsVisibleTo } from "../alerts/alerts.service.js";
import { LeadersService } from "./leaders.service.js";

@Controller("leaders")
export class LeadersController {
  constructor(private readonly leadersService: LeadersService) {}

  /** Market data: public. */
  @Public()
  @Get()
  findAll(@Query() query: LeadersQuery): Promise<LeaderSummary[]> {
    return this.leadersService.findAll(query);
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
      chain,
      address,
      equityInterval === "5m" ? "5m" : "hour",
      alertsVisibleTo(user),
    );
  }

  /** A3: label/tier/notes/active. */
  @Roles("admin")
  @Patch(":chain/:address")
  update(
    @Param("chain") chain: string,
    @Param("address") address: string,
    @Body() body: PatchLeaderRequest,
  ): Promise<Leader> {
    return this.leadersService.update(chain, address, body);
  }
}
