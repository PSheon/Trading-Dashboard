import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import type {
  Leader,
  LeaderDetailResponse,
  LeaderSummary,
  LeadersQuery,
  PatchLeaderRequest,
} from "@trading-dashboard/shared";

import { LeadersService } from "./leaders.service.js";

@Controller("leaders")
export class LeadersController {
  constructor(private readonly leadersService: LeadersService) {}

  @Get()
  findAll(@Query() query: LeadersQuery): Promise<LeaderSummary[]> {
    return this.leadersService.findAll(query);
  }

  /** D3: current positions, fill history, equity curve, coin distribution,
   * alert history. `?equityInterval=hour|5m` — defaults to `hour` (§11:
   * "詳情頁預設每小時一點，可切 5 分鐘"). */
  @Get(":chain/:address")
  findDetail(
    @Param("chain") chain: string,
    @Param("address") address: string,
    @Query("equityInterval") equityInterval?: "hour" | "5m",
  ): Promise<LeaderDetailResponse> {
    return this.leadersService.findDetail(chain, address, equityInterval === "5m" ? "5m" : "hour");
  }

  /** A3: label/tier/notes/active. */
  @Patch(":chain/:address")
  update(
    @Param("chain") chain: string,
    @Param("address") address: string,
    @Body() body: PatchLeaderRequest,
  ): Promise<Leader> {
    return this.leadersService.update(chain, address, body);
  }
}
