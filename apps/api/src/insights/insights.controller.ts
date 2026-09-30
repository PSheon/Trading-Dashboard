import { ApiDoc } from "../common/decorators/http.decorator.js";
import { Controller, Get, Param, Query } from "@nestjs/common";
import type { CohortDetailResponse, CohortHistoryResponse, CrowdResponse } from "@trading-dashboard/shared/contracts";

import { Public } from "../common/auth/public.decorator.js";
import { CohortService } from "./cohort.service.js";
import { CohortHistoryQueryDto, CohortParamsDto } from "./dto/cohorts.dto.js";
import { InsightsService } from "./insights.service.js";

@Public()
@Controller("insights")
export class InsightsController {
  constructor(
    private readonly insights: InsightsService,
    private readonly cohorts: CohortService,
  ) {}

  /** Per-coin long/short of the tracked traders (cached 60 s). */
  @ApiDoc("Crowd")
  @Get("crowd")
  crowd(): Promise<CrowdResponse> {
    return this.insights.crowd();
  }

  /** A PnL tier's current positioning (cached 30 s; no upstream calls). */
  @ApiDoc("Cohort", "Hero figures, per-market split and wallets of one PnL tier (CopyDog's cohorts).")
  @Get("cohorts/:tier")
  cohort(@Param() params: CohortParamsDto): Promise<CohortDetailResponse> {
    return this.cohorts.detail(params.tier);
  }

  @ApiDoc("Cohort history", "The tier's long share per refresh and BTC's price over 7d / 30d / 90d / all.")
  @Get("cohorts/:tier/history")
  cohortHistory(@Param() params: CohortParamsDto, @Query() query: CohortHistoryQueryDto): Promise<CohortHistoryResponse> {
    return this.cohorts.history(params.tier, query.window);
  }
}
