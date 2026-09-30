import { IsString, IsBoolean, IsInt, Min, Max, MaxLength, IsIn } from "class-validator";
import { Optional, ToNumber } from "../../common/decorators/input.decorator.js";
import type * as c from "@trading-dashboard/shared/contracts";

export class AdminUsersQueryDto {
  @Optional() @IsString() @MaxLength(64) declare q?: string;
  @Optional() @IsIn(["user", "admin"]) declare role?: c.UserRole;
  @ToNumber() @IsInt() @Min(1) @Max(100) limit = 50;
  @ToNumber() @IsInt() @Min(0) offset = 0;
}
export class PatchAdminUserDto {
  @Optional() @IsIn(["user", "admin"]) declare role?: c.UserRole;
  @Optional() @IsBoolean() declare disabled?: boolean;
}
export class AdminRevenueQueryDto {
  @IsIn(["7d", "30d", "90d", "all"]) range: c.AdminRevenueQuery["range"] = "30d";
}
