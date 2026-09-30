import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsBoolean, IsInt, Min, Max, MaxLength, IsIn } from "class-validator";
import { Optional, ToNumber } from "../../common/decorators/input.decorator.js";
import type * as c from "@trading-dashboard/shared/contracts";

export class AdminUsersQueryDto {
  @ApiPropertyOptional({ type: String, maxLength: 64 })
  @Optional() @IsString() @MaxLength(64) declare q?: string;
  @ApiPropertyOptional({ type: String, enum: ["user", "admin"] })
  @Optional() @IsIn(["user", "admin"]) declare role?: c.UserRole;
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 100, default: 50 })
  @ToNumber() @IsInt() @Min(1) @Max(100) limit = 50;
  @ApiPropertyOptional({ type: "integer", minimum: 0, default: 0 })
  @ToNumber() @IsInt() @Min(0) offset = 0;
}
export class PatchAdminUserDto {
  @ApiPropertyOptional({ type: String, enum: ["user", "admin"] })
  @Optional() @IsIn(["user", "admin"]) declare role?: c.UserRole;
  @ApiPropertyOptional({ type: Boolean })
  @Optional() @IsBoolean() declare disabled?: boolean;
}
export class AdminRevenueQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["7d", "30d", "90d", "all"], default: "30d" })
  @IsIn(["7d", "30d", "90d", "all"]) range: c.AdminRevenueQuery["range"] = "30d";
}
