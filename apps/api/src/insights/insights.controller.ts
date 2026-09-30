import { ApiDoc } from "../common/decorators/http.decorator.js";
import { Controller, Get } from "@nestjs/common";
import type { CrowdResponse } from "@trading-dashboard/shared/contracts";

import { Public } from "../common/auth/public.decorator.js";
import { InsightsService } from "./insights.service.js";

@Public()
@Controller("insights")
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  /** Per-coin long/short of the tracked traders (cached 60 s). */
  @ApiDoc("Crowd")
  @Get("crowd")
  crowd(): Promise<CrowdResponse> {
    return this.insights.crowd();
  }
}
