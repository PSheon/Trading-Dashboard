import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

import { Trim } from "../../common/decorators/input.decorator.js";

export class AdminLiveOrdersQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["open", "unknown", "all"], default: "open", description: "open: not terminal yet; unknown: sent, outcome not confirmed by the exchange" })
  @IsIn(["open", "unknown", "all"]) state: "open" | "unknown" | "all" = "open";
}

export class AdminLiveLatencyQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["24h", "7d"], default: "24h" })
  @IsIn(["24h", "7d"]) window: "24h" | "7d" = "24h";
}

export class AdminLiveGrantParamsDto {
  @ApiProperty({ type: String, maxLength: 128 })
  @IsString() @MaxLength(128) @Matches(/^[A-Za-z0-9_:.-]+$/) declare id: string;
}

/** Mirrors adminRevokeLiveGrantSchema (the service re-parses with it). */
export class AdminRevokeLiveGrantDto {
  @ApiProperty({ type: String, minLength: 3, maxLength: 500 })
  @Trim() @IsString() @MinLength(3) @MaxLength(500) declare reason: string;
  @ApiPropertyOptional({ type: Boolean, description: "Revoke now even while the copy's stop has not ended; positions may remain on the copy account" })
  @IsOptional() @IsBoolean() force?: boolean;
}
