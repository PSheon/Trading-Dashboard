import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsInt, Min, Max, IsIn, Matches, IsDate, ValidateIf } from "class-validator";
import { Transform } from "class-transformer";
import { Optional, ToLowerCase, ToNumber, IsActionCursor } from "../../../common/decorators/input.decorator.js";
import type * as c from "@trading-dashboard/shared/contracts";

export class ActionsStreamQueryDto {
  @ApiPropertyOptional({ type: String, enum: ["all", "favorites"], default: "all" })
  @IsIn(["all", "favorites"]) scope: "all" | "favorites" = "all";
  @ApiPropertyOptional({ type: String, pattern: "^0x[0-9a-fA-F]{40}$" })
  @Optional() @ToLowerCase() @Matches(/^0x[0-9a-f]{40}$/) declare address?: string;
  @ApiPropertyOptional({ type: String })
  @Optional() @IsString() declare coin?: string;
  @ApiPropertyOptional({ type: String, enum: ["open", "add", "reduce", "close", "flip", "liquidation"] })
  @Optional() @IsIn(["open", "add", "reduce", "close", "flip", "liquidation"]) declare kind?: c.ActionKind;
  @ApiPropertyOptional({ type: String, enum: ["A", "B", "C"] })
  @Optional() @IsIn(["A", "B", "C"]) declare tier?: c.Tier;
}
export class ActionsFeedQueryDto extends ActionsStreamQueryDto {
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 500, default: 100 })
  @ToNumber() @IsInt() @Min(1) @Max(500) limit = 100;
  @ValidateIf((object: ActionsFeedQueryDto, value) => value !== undefined || object.beforeId !== undefined)
  @Transform(({ value }) => typeof value === "string" ? new Date(value) : value, { toClassOnly: true })
  @ApiPropertyOptional({ type: String, format: "date-time", description: "ISO timestamp; required when beforeId is supplied." })
  @IsDate() declare before?: Date;
  @ApiPropertyOptional({ type: String, pattern: "^[1-9]\\d{0,18}$", description: "Positive PostgreSQL bigint as a decimal string; maximum 9223372036854775807." })
  @Optional() @IsActionCursor() declare beforeId?: string;
}
