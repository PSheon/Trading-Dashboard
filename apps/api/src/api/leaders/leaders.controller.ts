import { ApiDoc } from "../../common/decorators/http.decorator.js";
import { LeadersQueryDto, LeaderDetailQueryDto, PatchLeaderDto } from "./dto/leader.dto.js";
import { LeaderParamsDto } from "../../common/dto/params.dto.js";
import { RequirePermissions, hasPermission } from "../../common/auth/permissions.js";
import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import type { Leader, LeaderDetailResponse, LeaderSummary, PublicLeaderSummary } from "@trading-dashboard/shared/contracts";



import { CurrentUser, type RequestUser } from "../../common/auth/current-user.js";
import { Public } from "../../common/auth/public.decorator.js";
import { alertsVisibleTo } from "../../common/auth/alerts-scope.js";
import { LeadersService } from "./leaders.service.js";

/** What a caller sees of leaders: full rows only with `leaders.manage`. */
function viewOf(user: RequestUser | null): "public" | "admin" {
  return hasPermission(user, "leaders.manage") ? "admin" : "public";
}

@Controller("leaders")
export class LeadersController {
  constructor(private readonly leadersService: LeadersService) {}

  /** Market data: public, as the public projection (imported leaders, no
   * notes or source); full rows for callers with `leaders.manage`. */
  @Public()
  @ApiDoc("Find all")
  @Get()
  findAll(@Query() query: LeadersQueryDto, @CurrentUser() user: RequestUser | null = null): Promise<LeaderSummary[] | PublicLeaderSummary[]> {
    return this.leadersService.findAll(query, viewOf(user));
  }

  /** D3: current positions, fill history, equity curve, coin distribution,
   * alert history. `?equityInterval=hour|5m` — defaults to `hour` (§11:
   * "詳情頁預設每小時一點，可切 5 分鐘"). Public; the alert history is the
   * caller's own (empty when anonymous, everyone's for admins). */
  @Public()
  @ApiDoc("Find detail")
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
      viewOf(user),
    );
  }

  /** A3: label/tier/notes/active. */
  @RequirePermissions("leaders.manage")
  @ApiDoc("Update")
  @Patch(":chain/:address")
  update(
    @Param() params: LeaderParamsDto,
    @Body() body: PatchLeaderDto,
    @CurrentUser() actor: RequestUser | null,
  ): Promise<Leader> {
    return this.leadersService.update(params.chain, params.address, body, actor);
  }
}
