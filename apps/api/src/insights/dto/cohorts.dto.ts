import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn } from "class-validator";
import type * as c from "@trading-dashboard/shared/contracts";

import { COHORT_TIERS } from "../cohorts.js";

export class CohortParamsDto {
  @ApiProperty({ type: String, enum: COHORT_TIERS })
  @IsIn(COHORT_TIERS) declare tier: c.CohortTier;
}

export class CohortHistoryQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["7d", "30d", "90d", "all"], default: "all" })
  @IsIn(["7d", "30d", "90d", "all"]) window: c.CohortWindow = "all";
}
