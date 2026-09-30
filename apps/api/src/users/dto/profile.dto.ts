import { IsString, IsBoolean, Min, Max, MaxLength, IsIn, IsNumber } from "class-validator";
import { Optional, Nullable } from "../../common/decorators/input.decorator.js";
import type * as c from "@trading-dashboard/shared/contracts";

export class PatchMeDto {
  @Optional() @IsIn(["zh-TW", "en"]) declare locale?: c.PatchMeRequest["locale"];
  @Nullable() @IsString() @MaxLength(64) declare displayName?: string | null;
}
export class PatchFavoriteAlertDto {
  @Optional() @IsBoolean() declare enabled?: boolean;
  @Optional() @IsIn(["buy", "sell", "both"]) declare sides?: c.AlertSides;
  @Nullable() @IsNumber() @Min(0) @Max(1e12) declare minUsd?: number | null;
}
