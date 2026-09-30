import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsBoolean, Min, Max, MaxLength, IsIn, IsNumber } from "class-validator";
import { Optional, Nullable } from "../../common/decorators/input.decorator.js";
import type * as c from "@trading-dashboard/shared/contracts";

export class PatchMeDto {
  @ApiPropertyOptional({ type: String, enum: ["zh-TW", "en"] })
  @Optional() @IsIn(["zh-TW", "en"]) declare locale?: c.PatchMeRequest["locale"];
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 64 })
  @Nullable() @IsString() @MaxLength(64) declare displayName?: string | null;
}
export class PatchFavoriteAlertDto {
  @ApiPropertyOptional({ type: Boolean })
  @Optional() @IsBoolean() declare enabled?: boolean;
  @ApiPropertyOptional({ type: String, enum: ["buy", "sell", "both"] })
  @Optional() @IsIn(["buy", "sell", "both"]) declare sides?: c.AlertSides;
  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 1e12 })
  @Nullable() @IsNumber() @Min(0) @Max(1e12) declare minUsd?: number | null;
}
