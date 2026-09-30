import { LeadersQueryDto, LeaderDetailQueryDto, PatchLeaderDto } from "./dto/leader.dto.js";
import { LeaderParamsDto } from "../../common/dto/params.dto.js";
import { RequirePermissions } from "../../common/auth/permissions.js";
import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import type { Leader, LeaderDetailResponse, LeaderSummary } from "@trading-dashboard/shared/contracts";



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
  findAll(@Query() query: LeadersQueryDto): Promise<LeaderSummary[]> {
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
    @Param() params: LeaderParamsDto,
    @Query() query: LeaderDetailQueryDto,
  ): Promise<LeaderDetailResponse> {
    return this.leadersService.findDetail(
      params.chain,
      params.address,
      query.equityInterval ?? "hour",
      alertsVisibleTo(user),
    );
  }

  /** A3: label/tier/notes/active. */
  @RequirePermissions("leaders.manage")
  @Patch(":chain/:address")
  update(
    @Param() params: LeaderParamsDto,
    @Body() body: PatchLeaderDto,
    @CurrentUser() actor: RequestUser | null,
  ): Promise<Leader> {
    return this.leadersService.update(params.chain, params.address, body, actor);
  }
}
