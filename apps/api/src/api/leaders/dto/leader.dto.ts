import { IsString, IsBoolean, IsIn } from "class-validator";
import { Optional, Nullable, ToBoolean } from "../../../common/decorators/input.decorator.js";
import type * as c from "@trading-dashboard/shared/contracts";

export class LeadersQueryDto {
  @Optional() @IsIn(["A", "B", "C"]) declare tier?: c.Tier;
  @Optional() @ToBoolean() @IsBoolean() declare active?: boolean;
}
export class LeaderDetailQueryDto {
  @Optional() @IsIn(["hour", "5m"]) declare equityInterval?: "hour" | "5m";
}
export class PatchLeaderDto {
  @Nullable() @IsString() declare label?: string | null;
  @Optional() @IsIn(["A", "B", "C"]) declare tier?: c.Tier;
  @Nullable() @IsString() declare notes?: string | null;
  @Optional() @IsBoolean() declare active?: boolean;
}
