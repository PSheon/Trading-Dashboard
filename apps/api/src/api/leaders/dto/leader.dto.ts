import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsBoolean, IsIn } from "class-validator";
import { Optional, Nullable, ToBoolean } from "../../../common/decorators/input.decorator.js";
import type * as c from "@trading-dashboard/shared/contracts";

export class LeadersQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["A", "B", "C"] })
  @Optional() @IsIn(["A", "B", "C"]) declare tier?: c.Tier;
  @ApiPropertyOptional({ type: String, enum: ["true", "false"] })
  @Optional() @ToBoolean() @IsBoolean() declare active?: boolean;
}
export class LeaderDetailQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["hour", "5m"] })
  @Optional() @IsIn(["hour", "5m"]) declare equityInterval?: "hour" | "5m";
}
export class PatchLeaderDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  @Nullable() @IsString() declare label?: string | null;
  @ApiPropertyOptional({ type: String, enum: ["A", "B", "C"] })
  @Optional() @IsIn(["A", "B", "C"]) declare tier?: c.Tier;
  @ApiPropertyOptional({ type: String, nullable: true })
  @Nullable() @IsString() declare notes?: string | null;
  @ApiPropertyOptional({ type: Boolean })
  @Optional() @IsBoolean() declare active?: boolean;
}
